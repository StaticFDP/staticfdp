#!/usr/bin/env python3
"""
issues_to_datasets.py
=====================
Reads GitHub Issues and converts them into per-disease FAIR datasets:

  diseases/{slug}/
    metadata.ttl   ← DCAT Dataset (versioned by git SHA)
    cases.ttl      ← individual case submissions for this disease
    gaps.ttl       ← ontology + data gaps linked to this disease
    README.md      ← auto-generated human summary

  docs/diseases/
    index.html     ← biohackathon landing page (machine-readable index)
    index.ttl      ← DCAT Catalog over all disease datasets
    index.jsonld   ← JSON-LD version (Google Dataset Search)
    {slug}.ttl     ← per-disease Turtle (served via GitHub Pages)
    {slug}.jsonld  ← per-disease JSON-LD

  docs/fdp/
    submissions.ttl ← flat backward-compatible aggregate (unchanged)

Labels consumed:
  disease-case   →  diseases/{slug}/cases.ttl
  ontology-gap   →  diseases/{slug}/gaps.ttl  (matched by disease IDs)
  data-gap       →  diseases/{slug}/gaps.ttl  (matched by disease IDs)

Environment variables:
  GITHUB_TOKEN   — PAT with issues:read (required for >60 req/hr)
  GITHUB_REPO    — owner/name  (default: StaticFDP/ga4gh-rare-disease-trajectories)
  GITHUB_SHA     — commit SHA for dcterms:hasVersion (set automatically in Actions)
  OUTPUT_BASE    — repo root directory (default: .)
"""

import os
import re
import sys
import json
import datetime
import urllib.request
import urllib.parse
from pathlib import Path

# ── Config — read fdp-config.yaml, override with env vars ────────────────────

def _load_fdp_config() -> dict:
    """
    Load fdp-config.yaml from the repo root (one level up from this script).
    Returns an empty dict if the file is absent or unparseable.
    Requires only stdlib — no PyYAML needed (uses a minimal key:value parser
    that handles the simple structure of fdp-config.yaml).
    """
    config_path = Path(__file__).parent.parent / "fdp-config.yaml"
    if not config_path.exists():
        return {}
    try:
        # Minimal YAML parser for our known structure (avoids PyYAML dep)
        import re as _re
        result: dict = {}
        stack: list  = [result]
        indent_stack: list = [-1]
        with open(config_path, encoding="utf-8") as f:
            for raw in f:
                line = raw.rstrip()
                if not line or line.lstrip().startswith("#"):
                    continue
                indent = len(line) - len(line.lstrip())
                # pop stack on dedent
                while indent <= indent_stack[-1]:
                    stack.pop(); indent_stack.pop()
                m = _re.match(r'^(\s*)([^:]+):\s*(.*)', line)
                if not m:
                    continue
                key = m.group(2).strip()
                val = m.group(3).strip().strip('"\'')
                parent = stack[-1]
                if not isinstance(parent, dict):
                    continue
                if val == "":
                    child: dict = {}
                    parent[key] = child
                    stack.append(child)
                    indent_stack.append(indent)
                else:
                    parent[key] = val
        return result
    except Exception as e:
        print(f"[config] Warning: could not parse fdp-config.yaml: {e}", file=sys.stderr)
        return {}

_CFG = _load_fdp_config()

def _cfg(*keys, default=""):
    """Traverse nested config dict by keys."""
    node = _CFG
    for k in keys:
        if not isinstance(node, dict):
            return default
        node = node.get(k, default)
    return node if node != "" else default

# ── Runtime values (env vars override config file) ───────────────────────────

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_SHA   = os.environ.get("GITHUB_SHA",   "unknown")
BASE         = Path(os.environ.get("OUTPUT_BASE", "."))

# Platform selection — read from config, overridable via env vars.
# INFRASTRUCTURE_OVERRIDE (set by workflow_dispatch input) takes top precedence.
_OVERRIDE = os.environ.get("INFRASTRUCTURE_OVERRIDE", "").strip()
_PRIMARY  = _OVERRIDE or _cfg("infrastructure", "primary", default="github")

GITHUB_REPO = (
    os.environ.get("GITHUB_REPO")
    or _cfg("infrastructure", "github", "repo")
    or "StaticFDP/ga4gh-rare-disease-trajectories"
)
USE_GITHUB = (
    os.environ.get("GITHUB_TOKEN", "") != ""        # token present means enabled
    or _cfg("infrastructure", "github", "enabled") == "true"
    or _PRIMARY in ("github", "both")
)

FORGEJO_TOKEN    = os.environ.get("FORGEJO_TOKEN", "")
FORGEJO_REPO     = (
    os.environ.get("FORGEJO_REPO")
    or _cfg("infrastructure", "codeberg", "repo")
    or "StaticFDP/ga4gh-rare-disease-trajectories"
)
FORGEJO_BASE_URL = (
    os.environ.get("FORGEJO_BASE_URL")
    or _cfg("infrastructure", "codeberg", "base_url")
    or "https://codeberg.org"
)
USE_FORGEJO = bool(FORGEJO_TOKEN)

FDP_BASE_URL = (
    os.environ.get("FDP_BASE_URL")
    or _cfg("fdp", "base_url")
    or "https://fdp.semscape.org/ga4gh-rare-disease-trajectories"
)
GITHUB_TREE_URL  = f"https://github.com/{GITHUB_REPO}/tree/main/diseases"
TODAY            = datetime.date.today().isoformat()

# Announce active configuration
_src = "fdp-config.yaml" if _CFG else "defaults"
print(f"[config] Loaded from {_src}")
print(f"[config] Primary platform: {_PRIMARY}  |  GitHub: {USE_GITHUB}  |  Forgejo: {USE_FORGEJO}")
print(f"[config] FDP base URL: {FDP_BASE_URL}")

# ── Ontology prefix → IRI ─────────────────────────────────────────────────────

ONTOLOGY_IRI = {
    "ORPHA":    ("http://www.orpha.net/ORDO/Orphanet_{id}",       1),  # priority 1 (highest)
    "ORDO":     ("http://www.orpha.net/ORDO/Orphanet_{id}",       1),
    "OMIM":     ("https://omim.org/entry/{id}",                   2),
    "MONDO":    ("http://purl.obolibrary.org/obo/MONDO_{id}",     3),
    "HP":       ("http://purl.obolibrary.org/obo/HP_{id}",        9),  # phenotype, not disease
    "HPO":      ("http://purl.obolibrary.org/obo/HP_{id}",        9),
    "GARD":     ("https://rarediseases.info.nih.gov/diseases/{id}", 4),
    "ICD10":    ("http://id.who.int/icd/release/10/{id}",         5),
    "ICD-10":   ("http://id.who.int/icd/release/10/{id}",         5),
    "ICD11":    ("http://id.who.int/icd/entity/{id}",             5),
    "ICD-11":   ("http://id.who.int/icd/entity/{id}",             5),
    "SNOMED":   ("http://snomed.info/id/{id}",                    6),
    "SNOMEDCT": ("http://snomed.info/id/{id}",                    6),
    "NANDO":    ("http://nanbyodata.jp/ontology/nando#{id}",      7),
    "MESH":     ("http://id.nlm.nih.gov/mesh/{id}",               8),
    "MeSH":     ("http://id.nlm.nih.gov/mesh/{id}",               8),
    "DOID":     ("http://purl.obolibrary.org/obo/DOID_{id}",      8),
}

# Ontology homepage for hyperlinks in HTML
ONTOLOGY_URL = {
    "ORPHA": "https://www.orpha.net/en/disease/detail/{id}",
    "ORDO":  "https://www.orpha.net/en/disease/detail/{id}",
    "OMIM":  "https://omim.org/entry/{id}",
    "MONDO": "https://monarchinitiative.org/disease/MONDO:{id}",
    "GARD":  "https://rarediseases.info.nih.gov/diseases/{id}",
}

NL = "\n"

TTL_PREFIXES = """\
@prefix dcat:    <https://www.w3.org/ns/dcat#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix foaf:    <http://xmlns.com/foaf/0.1/> .
@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .
@prefix ordo:    <http://www.orpha.net/ORDO/Orphanet_> .
@prefix omim:    <https://omim.org/entry/> .
@prefix hp:      <http://purl.obolibrary.org/obo/HP_> .
@prefix mondo:   <http://purl.obolibrary.org/obo/MONDO_> .
@prefix prov:    <http://www.w3.org/ns/prov#> .
@prefix schema:  <https://schema.org/> .

"""

# ── GitHub API ────────────────────────────────────────────────────────────────

def gh_get(path: str) -> list | dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    results, url = [], f"https://api.github.com{path}"
    while url:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            if isinstance(data, list):
                results.extend(data)
            else:
                return data
        link = resp.headers.get("Link", "")
        url = next((re.search(r'<([^>]+)>', p).group(1)
                    for p in link.split(",") if 'rel="next"' in p), None)
    return results


# ── Forgejo / Codeberg API (EU mirror) ────────────────────────────────────────

def forgejo_get(path: str) -> list | dict:
    """Fetch from Forgejo API (Gitea-compatible).  Returns [] if not configured."""
    if not FORGEJO_TOKEN:
        return []
    headers = {
        "Accept":        "application/json",
        "Authorization": f"token {FORGEJO_TOKEN}",
    }
    results, url = [], f"{FORGEJO_BASE_URL}/api/v1{path}"
    while url:
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                if isinstance(data, list):
                    results.extend(data)
                else:
                    return data
            link = resp.headers.get("Link", "")
            url = next((re.search(r'<([^>]+)>', p).group(1)
                        for p in link.split(",") if 'rel="next"' in p), None)
        except Exception as e:
            print(f"  [forgejo] warning: {e}", file=sys.stderr)
            break
    return results


def _normalise_issue(issue: dict, source: str) -> dict:
    """Normalise a Forgejo issue dict to look like a GitHub issue dict."""
    if source == "github":
        return issue
    # Forgejo label list uses {"name":...} same as GitHub — no change needed.
    # html_url is present in both. body may be None in both.
    issue.setdefault("html_url", "")
    issue.setdefault("body", "")
    issue.setdefault("labels", [])
    issue.setdefault("pull_request", None)
    return issue


def fetch_issues(label: str) -> list:
    """Fetch issues by label from GitHub, and optionally merge EU Forgejo issues."""
    lbl = urllib.parse.quote(label)

    # GitHub (primary)
    gh_issues = gh_get(f"/repos/{GITHUB_REPO}/issues?labels={lbl}&state=all&per_page=100")
    gh_issues = [i for i in gh_issues if "pull_request" not in i]

    # Forgejo (EU mirror) — merge if configured
    if FORGEJO_TOKEN:
        fj_issues = forgejo_get(f"/repos/{FORGEJO_REPO}/issues?type=issues&state=closed&limit=50&labels={lbl}")
        fj_issues += forgejo_get(f"/repos/{FORGEJO_REPO}/issues?type=issues&state=open&limit=50&labels={lbl}")
        fj_issues = [_normalise_issue(i, "forgejo") for i in fj_issues
                     if not i.get("pull_request")]

        # Deduplicate: skip Forgejo issues whose title already appears in GitHub set
        gh_titles = {i.get("title", "").strip() for i in gh_issues}
        new_from_eu = [i for i in fj_issues if i.get("title", "").strip() not in gh_titles]
        if new_from_eu:
            print(f"  [forgejo] merged {len(new_from_eu)} unique EU issue(s) for label '{label}'")
        gh_issues.extend(new_from_eu)

    return gh_issues

# ── Body parsing ──────────────────────────────────────────────────────────────

def section(body: str, heading: str) -> str:
    m = re.search(rf"###\s+{re.escape(heading)}\s*\n(.*?)(?=\n###|\Z)", body, re.DOTALL | re.IGNORECASE)
    if not m:
        return ""
    text = m.group(1).strip()
    # Strip trailing horizontal rules and form-footer boilerplate added by the Worker
    text = re.sub(r'\s*\n---.*$', '', text, flags=re.DOTALL).strip()
    return text


def parse_disease_ids(raw: str) -> list[tuple[str, str, str, int]]:
    """Returns [(prefix, local_id, iri, priority)] sorted by priority asc."""
    hits = []
    for m in re.finditer(r'([A-Za-z][A-Za-z0-9\-]*)[\s:_](\d+)', raw):
        prefix = m.group(1).upper()
        local  = m.group(2)
        entry  = ONTOLOGY_IRI.get(prefix)
        if entry:
            template, priority = entry
            hits.append((prefix, local, template.format(id=local), priority))
    # deduplicate by IRI
    seen, out = set(), []
    for h in sorted(hits, key=lambda x: x[3]):
        if h[2] not in seen:
            seen.add(h[2])
            out.append(h)
    return out


def disease_slug(ids: list[tuple], name: str) -> str:
    """Return canonical slug: orpha-{id} > omim-{id} > mondo-{id} > disease-{name-slug}"""
    priority_map = {"ORPHA": 1, "ORDO": 1, "OMIM": 2, "MONDO": 3}
    disease_ids = [i for i in ids if i[3] < 9]  # exclude HP/phenotype terms
    disease_ids = sorted(disease_ids, key=lambda x: priority_map.get(x[0], 5))
    if disease_ids:
        prefix, local, *_ = disease_ids[0]
        return f"{prefix.lower().replace('ordo','orpha')}-{local}"
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:50]
    return f"disease-{slug}" if slug else "disease-unknown"


def primary_display_id(ids: list[tuple]) -> tuple[str, str] | None:
    """Return (prefix, local_id) of the best display ID."""
    priority_map = {"ORPHA": 1, "ORDO": 1, "OMIM": 2, "MONDO": 3}
    disease_ids = [i for i in ids if i[3] < 9]
    if not disease_ids:
        return None
    best = sorted(disease_ids, key=lambda x: priority_map.get(x[0], 5))[0]
    return (best[0], best[1])


def parse_orcid(body: str) -> str | None:
    m = re.search(r'orcid\.org/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])', body, re.IGNORECASE)
    return m.group(1) if m else None

# ── Turtle helpers ────────────────────────────────────────────────────────────

def esc(s: str) -> str:
    return s.replace('\\', '\\\\').replace('"""', '\\"\\"\\"').replace('\r', '')


def ttl_literal(s: str, lang: str = "en") -> str:
    if '\n' in s:
        return f'"""{esc(s)}"""@{lang}'
    return f'"{esc(s)}"@{lang}'

# ── Per-disease Turtle: metadata.ttl ─────────────────────────────────────────

def make_metadata_ttl(slug: str, name: str, ids: list[tuple],
                      n_cases: int, n_gaps: int,
                      keywords: list[str], created: str) -> str:
    base = f"{FDP_BASE_URL}/diseases/{slug}"
    lines = [
        TTL_PREFIXES,
        f"# Disease dataset: {name}",
        f"# Slug: {slug}",
        f"# Auto-generated {TODAY} from GitHub Issues",
        f"# Version: {GITHUB_SHA[:12] if GITHUB_SHA != 'unknown' else 'local'}",
        "",
        f"<{base}/> a dcat:Dataset ;",
        f"    dcterms:title {ttl_literal(name)} ;",
        f"    dcterms:description {ttl_literal(f'Community-contributed disease trajectory data for {name}. Contains {n_cases} case submission(s) and {n_gaps} gap report(s), contributed during GA4GH BYOD sessions and maintained as FAIR linked data.')} ;",
        f'    dcterms:created    "{created}"^^xsd:date ;',
        f'    dcterms:modified   "{TODAY}"^^xsd:date ;',
        f'    dcterms:hasVersion "{GITHUB_SHA[:12] if GITHUB_SHA != "unknown" else TODAY}" ;',
        f"    dcterms:license    <https://creativecommons.org/licenses/by/4.0/> ;",
        f"    dcterms:publisher  <{FDP_BASE_URL}/fdp/> ;",
        f"    dcat:isPartOf      <{FDP_BASE_URL}/diseases/> ;",
        f"    dcat:landingPage   <https://github.com/{GITHUB_REPO}/tree/main/diseases/{slug}> ;",
        f"    prov:wasGeneratedBy <https://github.com/{GITHUB_REPO}/actions> ;",
    ]

    for prefix, local, iri, _ in ids:
        lines.append(f"    dcterms:subject <{iri}> ;")

    for kw in sorted(set(keywords)):
        if kw.strip():
            lines.append(f'    dcat:keyword "{esc(kw.strip())}"@en ;')

    lines.append(f"    dcat:distribution <{base}/cases.ttl> ,")
    lines.append(f"                      <{base}/gaps.ttl> .")
    lines.append("")
    lines.append(f"<{base}/cases.ttl> a dcat:Distribution ;")
    lines.append(f'    dcterms:title "Case submissions for {esc(name)}"@en ;')
    lines.append(f'    dcterms:format "text/turtle" ;')
    lines.append(f"    dcat:accessURL  <{FDP_BASE_URL}/diseases/{slug}.ttl> ;")
    lines.append(f"    dcat:downloadURL <{FDP_BASE_URL}/diseases/{slug}.ttl> .")
    lines.append("")
    lines.append(f"<{base}/gaps.ttl> a dcat:Distribution ;")
    lines.append(f'    dcterms:title "Ontology and data gaps for {esc(name)}"@en ;')
    lines.append(f'    dcterms:format "text/turtle" ;')
    lines.append(f"    dcat:accessURL  <{FDP_BASE_URL}/diseases/{slug}-gaps.ttl> ;")
    lines.append(f"    dcat:downloadURL <{FDP_BASE_URL}/diseases/{slug}-gaps.ttl> .")
    return "\n".join(lines) + "\n"


def make_cases_ttl(slug: str, name: str, cases: list[dict]) -> str:
    base = f"{FDP_BASE_URL}/diseases/{slug}"
    lines = [
        TTL_PREFIXES,
        f"# Case submissions for: {name}",
        f"# Source: https://github.com/{GITHUB_REPO}/issues?q=label%3Adisease-case",
        f"# Auto-generated {TODAY}",
        "",
    ]
    for issue in cases:
        body        = issue.get("body") or ""
        number      = issue["number"]
        html_url    = issue["html_url"]
        created     = issue["created_at"][:10]
        narrative   = section(body, "Disease narrative")
        contributor = section(body, "Contributor")
        registry    = section(body, "Registry or data source")
        orcid_id    = parse_orcid(body)

        lines.append(f"# Case #{number}")
        lines.append(f"<{base}/case/{number}> a dcat:Dataset ;")
        lines.append(f'    dcterms:title "Case #{number}: {esc(name)}"@en ;')
        lines.append(f'    dcat:isPartOf <{base}/> ;')
        if narrative:
            lines.append(f"    dcterms:description {ttl_literal(narrative[:800])} ;")
        lines.append(f'    dcterms:created   "{created}"^^xsd:date ;')
        lines.append(f'    dcterms:source    "GA4GH BYOD web form (ORCID-authenticated)" ;')
        lines.append(f"    dcat:landingPage  <{html_url}> ;")
        if registry:
            lines.append(f'    dcat:keyword "{esc(registry)}"@en ;')
        if orcid_id:
            lines.append(f"    dcterms:creator <https://orcid.org/{orcid_id}> ;")
        elif contributor:
            lines.append(f'    dcterms:creator [ foaf:name "{esc(contributor)}" ] ;')
        lines[-1] = lines[-1].rstrip(" ;") + " ."
        lines.append("")
    return "\n".join(lines)


def make_gaps_ttl(slug: str, name: str,
                  onto_gaps: list[dict], data_gaps: list[dict]) -> str:
    base = f"{FDP_BASE_URL}/diseases/{slug}"
    lines = [
        TTL_PREFIXES,
        f"# Ontology and data gaps for: {name}",
        f"# Auto-generated {TODAY}",
        "",
    ]
    for issue in onto_gaps:
        number  = issue["number"]
        body    = issue.get("body") or ""
        concept = section(body, "concept") or section(body, "Clinical concept")
        lines.append(f"<{base}/gap/onto/{number}> a schema:DefinedTerm ;")
        lines.append(f'    dcterms:title "Ontology gap #{number}"@en ;')
        lines.append(f'    dcat:isPartOf <{base}/> ;')
        if concept:
            lines.append(f'    dcterms:description {ttl_literal(concept[:600])} ;')
        lines.append(f"    dcat:landingPage <{issue['html_url']}> .")
        lines.append("")
    for issue in data_gaps:
        number = issue["number"]
        body   = issue.get("body") or ""
        desc   = section(body, "gap_description") or section(body, "Gap description")
        lines.append(f"<{base}/gap/data/{number}> a schema:DefinedTerm ;")
        lines.append(f'    dcterms:title "Data gap #{number}"@en ;')
        lines.append(f'    dcat:isPartOf <{base}/> ;')
        if desc:
            lines.append(f'    dcterms:description {ttl_literal(desc[:600])} ;')
        lines.append(f"    dcat:landingPage <{issue['html_url']}> .")
        lines.append("")
    if not onto_gaps and not data_gaps:
        lines.append("# No gaps reported yet for this disease.")
    return "\n".join(lines)


def make_readme(slug: str, name: str, ids: list[tuple],
                cases: list[dict], onto_gaps: list[dict],
                data_gaps: list[dict], created: str) -> str:
    disp = primary_display_id(ids)
    id_line = f"**{disp[0]}:{disp[1]}**" if disp else "_no ontology ID yet_"
    ont_url = (ONTOLOGY_URL.get(disp[0], "").format(id=disp[1]) if disp else "") if disp else ""

    return f"""\
# {name}

{id_line}{f" · [{disp[0]}:{disp[1]}]({ont_url})" if ont_url else ""}

> Community-contributed FAIR disease dataset — GA4GH Rare Disease Trajectories project.
> First contributed: {created} · Last updated: {TODAY}

## What is in this dataset?

| Resource | Count | Link |
|----------|------:|------|
| Case submissions | {len(cases)} | [cases.ttl]({FDP_BASE_URL}/diseases/{slug}.ttl) |
| Ontology gaps | {len(onto_gaps)} | [gaps.ttl]({FDP_BASE_URL}/diseases/{slug}-gaps.ttl) |
| Data model gaps | {len(data_gaps)} | [gaps.ttl]({FDP_BASE_URL}/diseases/{slug}-gaps.ttl) |

## Machine-readable access

```bash
# Turtle (RDF)
curl {FDP_BASE_URL}/diseases/{slug}.ttl

# JSON-LD
curl {FDP_BASE_URL}/diseases/{slug}.jsonld

# Dataset metadata
curl {FDP_BASE_URL}/diseases/{slug}/metadata.ttl
```

```python
# Python
from rdflib import Graph
g = Graph()
g.parse("{FDP_BASE_URL}/diseases/{slug}.ttl")
```

```sparql
# SPARQL — paste into https://fdp.semscape.org/sparql-demo/
SELECT ?case ?description WHERE {{
  <{FDP_BASE_URL}/diseases/{slug}/> dcat:hasPart ?case .
  OPTIONAL {{ ?case dcterms:description ?description }}
}}
```

## All disease identifiers

| Prefix | ID | Ontology |
|--------|----|----------|
{NL.join(f"| {p} | {l} | [{p}:{l}]({iri}) |" for p,l,iri,_ in ids)}

## Source issues

{NL.join(f"- [#{i['number']}]({i['html_url']}) — {i.get('title','')}" for i in cases)}

## Contributing

Submit additional cases or gaps via the [BYOD web forms](https://fdp.semscape.org/ga4gh-rare-disease-trajectories/)
or directly as [GitHub Issues](https://github.com/{GITHUB_REPO}/issues/new/choose).

---
*Auto-generated by [issues_to_datasets.py](https://github.com/{GITHUB_REPO}/blob/main/scripts/issues_to_datasets.py) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)*
"""


def make_index_ttl(diseases: list[dict]) -> str:
    lines = [
        TTL_PREFIXES,
        f"# Disease Dataset Index — GA4GH Rare Disease Trajectories",
        f"# Auto-generated {TODAY} | {len(diseases)} disease dataset(s)",
        "",
        f"<{FDP_BASE_URL}/diseases/> a dcat:Catalog ;",
        f'    dcterms:title "GA4GH Rare Disease Trajectory Datasets"@en ;',
        f'    dcterms:description "Community-contributed, FAIR-compliant disease trajectory datasets from GA4GH biohackathon sessions. Each dataset covers one disease: case submissions, phenotype data, and identified ontology/data gaps."@en ;',
        f'    dcterms:modified   "{TODAY}"^^xsd:date ;',
        f'    dcterms:hasVersion "{GITHUB_SHA[:12] if GITHUB_SHA != "unknown" else TODAY}" ;',
        f'    dcterms:license    <https://creativecommons.org/licenses/by/4.0/> ;',
        f'    dcterms:publisher  <{FDP_BASE_URL}/fdp/> ;',
        f'    dcat:isPartOf      <{FDP_BASE_URL}/fdp/catalog/> ;',
    ]
    for d in diseases:
        lines.append(f"    dcat:dataset <{FDP_BASE_URL}/diseases/{d['slug']}/> ;")
    lines[-1] = lines[-1].rstrip(" ;") + " ."
    lines.append("")
    for d in diseases:
        slug = d["slug"]
        name = d["name"]
        lines.append(f"<{FDP_BASE_URL}/diseases/{slug}/> a dcat:Dataset ;")
        lines.append(f"    dcterms:title {ttl_literal(name)} ;")
        lines.append(f'    dcterms:modified "{TODAY}"^^xsd:date ;')
        for _, _, iri, _ in d["ids"]:
            lines.append(f"    dcterms:subject <{iri}> ;")
        lines.append(f'    dcat:accessURL <{FDP_BASE_URL}/diseases/{slug}.ttl> .')
        lines.append("")
    return "\n".join(lines)


def make_index_jsonld(diseases: list[dict], date_str: str) -> str:
    datasets = []
    for d in diseases:
        disp = primary_display_id(d["ids"])
        entry = {
            "@type": "Dataset",
            "name": d["name"],
            "url": f"{FDP_BASE_URL}/diseases/{d['slug']}/",
            "dateModified": date_str,
            "license": "https://creativecommons.org/licenses/by/4.0/",
            "distribution": {
                "@type": "DataDownload",
                "encodingFormat": "text/turtle",
                "contentUrl": f"{FDP_BASE_URL}/diseases/{d['slug']}.ttl"
            }
        }
        if disp:
            entry["identifier"] = f"{disp[0]}:{disp[1]}"
        datasets.append(entry)

    catalog = {
        "@context": "https://schema.org/",
        "@type": "DataCatalog",
        "name": "GA4GH Rare Disease Trajectory Datasets",
        "description": "Community-contributed FAIR disease trajectory datasets from GA4GH biohackathon sessions.",
        "url": f"{FDP_BASE_URL}/diseases/",
        "dateModified": date_str,
        "license": "https://creativecommons.org/licenses/by/4.0/",
        "publisher": {
            "@type": "Organization",
            "name": "GA4GH Rare Disease Phenotyping Working Group",
            "url": "https://www.ga4gh.org/"
        },
        "dataset": datasets
    }
    return json.dumps(catalog, indent=2, ensure_ascii=False)


def make_index_html(diseases: list[dict], jsonld: str) -> str:
    """Generate the biohackathon landing page."""

    def disease_card(d: dict) -> str:
        slug   = d["slug"]
        name   = d["name"]
        n_cases = d["n_cases"]
        n_onto  = d["n_onto_gaps"]
        n_data  = d["n_data_gaps"]
        disp    = primary_display_id(d["ids"])
        created = d["created"]

        id_badge = ""
        if disp:
            prefix, local = disp
            url = ONTOLOGY_URL.get(prefix, "").format(id=local)
            id_badge = f'<a href="{url}" target="_blank" class="id-badge">{prefix}:{local}</a>' if url else f'<span class="id-badge">{prefix}:{local}</span>'

        type_chips = " ".join(
            f'<span class="chip">{kw}</span>'
            for kw in d.get("keywords", [])[:4]
        )

        return f"""
      <div class="disease-card" id="{slug}">
        <div class="dc-header">
          <div class="dc-name">{name}</div>
          {id_badge}
        </div>
        <div class="dc-stats">
          <span title="Case submissions">{n_cases} case{"s" if n_cases != 1 else ""}</span>
          <span title="Ontology gaps">{n_onto} ontology gap{"s" if n_onto != 1 else ""}</span>
          <span title="Data gaps">{n_data} data gap{"s" if n_data != 1 else ""}</span>
        </div>
        {f'<div class="dc-chips">{type_chips}</div>' if type_chips else ""}
        <div class="dc-meta">First contributed: {created} · Updated: {TODAY}</div>
        <div class="dc-actions">
          <a href="{FDP_BASE_URL}/diseases/{slug}.ttl" class="btn btn-ttl">TTL</a>
          <a href="{FDP_BASE_URL}/diseases/{slug}.jsonld" class="btn btn-jsonld">JSON-LD</a>
          <a href="https://github.com/{GITHUB_REPO}/tree/main/diseases/{slug}" target="_blank" class="btn btn-gh">GitHub ↗</a>
          <a href="https://fdp.semscape.org/sparql-demo/" target="_blank" class="btn btn-sparql">SPARQL ↗</a>
        </div>
      </div>"""

    cards_html = "\n".join(disease_card(d) for d in diseases) if diseases else \
        '<div class="empty-state">No disease datasets yet — be the first to <a href="https://byod-form-receiver.andra-76d.workers.dev/forms/disease-case">submit a disease case</a>!</div>'

    n = len(diseases)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Rare Disease Datasets — GA4GH BYOD</title>
  <meta name="description" content="{n} community-contributed, FAIR-compliant rare disease trajectory datasets from GA4GH biohackathon sessions. Machine-readable RDF/Turtle and JSON-LD." />
  <link rel="alternate" type="text/turtle"    href="index.ttl" />
  <link rel="alternate" type="application/ld+json" href="index.jsonld" />

  <script type="application/ld+json">
{jsonld}
  </script>

  <style>
    *,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
    :root{{
      --green:#2ea44f;--green-d:#22863a;--blue:#0969da;
      --gray-1:#f6f8fa;--gray-2:#eaeef2;--gray-3:#d0d7de;
      --gray-7:#57606a;--gray-9:#1f2328;--purple:#8250df;
      --radius:10px;
    }}
    body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          color:var(--gray-9);background:#fff;line-height:1.5}}
    a{{color:var(--blue);text-decoration:none}}
    a:hover{{text-decoration:underline}}
    nav{{background:#1a4a8a;color:#fff;padding:0 1.5rem;
         display:flex;align-items:center;gap:1.25rem;height:52px}}
    nav a{{color:rgba(255,255,255,.8);font-size:.88rem}}
    nav a:hover{{color:#fff}}
    nav .brand{{font-weight:700;color:#fff;font-size:1rem;
                display:flex;align-items:center;gap:.45rem}}
    nav .brand img{{height:28px;border-radius:4px}}
    nav .brand span{{color:rgba(255,255,255,.65);font-weight:400;font-size:.86em}}
    nav .spacer{{flex:1}}
    .band{{background:linear-gradient(135deg,#0d1117,#161b22);
           color:#fff;padding:2.5rem 1.5rem 2rem}}
    .band h1{{font-size:1.7rem;font-weight:800;margin-bottom:.5rem}}
    .band .lead{{color:#8b949e;max-width:680px;font-size:.95rem;line-height:1.7;margin-bottom:1.25rem}}
    .badges{{display:flex;gap:.6rem;flex-wrap:wrap}}
    .badge{{display:inline-block;border-radius:20px;font-size:.78rem;
            font-weight:600;padding:.2rem .7rem;letter-spacing:.02em}}
    .badge-green{{background:rgba(46,164,79,.2);color:#3fb950;border:1px solid rgba(46,164,79,.3)}}
    .badge-blue{{background:rgba(9,105,218,.2);color:#79c0ff;border:1px solid rgba(9,105,218,.3)}}
    .badge-gray{{background:rgba(110,118,129,.2);color:#8b949e;border:1px solid rgba(110,118,129,.3)}}
    .page{{max-width:1100px;margin:0 auto;padding:2rem 1.5rem}}
    h2{{font-size:1.15rem;font-weight:700;margin-bottom:.5rem}}
    .section-intro{{color:var(--gray-7);font-size:.9rem;margin-bottom:1.5rem}}

    /* access panel */
    .access-panel{{background:var(--gray-9);color:#fff;border-radius:var(--radius);
                   padding:1.5rem;margin-bottom:2.5rem;display:grid;
                   grid-template-columns:1fr 1fr;gap:1.5rem}}
    @media(max-width:640px){{.access-panel{{grid-template-columns:1fr}}}}
    .access-panel h3{{font-size:.95rem;color:#fff;margin-bottom:.75rem}}
    .access-panel pre{{background:#0d1117;border:1px solid #30363d;border-radius:6px;
                        padding:.75rem 1rem;font-size:.78rem;overflow-x:auto;
                        color:#e6edf3;line-height:1.6;margin-bottom:.5rem}}
    .access-links{{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.75rem}}
    .btn-dl{{display:inline-block;padding:.4rem .9rem;border-radius:6px;font-size:.82rem;
             font-weight:600;color:#fff;text-decoration:none}}
    .btn-ttl{{background:#6639ba}}
    .btn-jsonld{{background:#0969da}}
    .btn-sparql{{background:var(--green)}}

    /* disease cards */
    .disease-grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));
                   gap:1.1rem;margin-top:1.25rem}}
    .disease-card{{border:1px solid var(--gray-3);border-radius:var(--radius);
                   padding:1.2rem;background:#fff;
                   transition:border-color .15s,box-shadow .15s}}
    .disease-card:hover{{border-color:var(--green);box-shadow:0 0 0 3px rgba(46,164,79,.1)}}
    .dc-header{{display:flex;align-items:flex-start;justify-content:space-between;
                gap:.5rem;margin-bottom:.6rem}}
    .dc-name{{font-weight:700;font-size:1rem}}
    .id-badge{{font-size:.75rem;font-weight:600;background:#f0fff4;
               border:1px solid #aef4c5;color:#116329;border-radius:12px;
               padding:.15rem .55rem;white-space:nowrap;text-decoration:none}}
    .id-badge:hover{{background:#d1f7dc}}
    .dc-stats{{display:flex;gap:1rem;font-size:.82rem;color:var(--gray-7);margin-bottom:.5rem}}
    .dc-chips{{display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.5rem}}
    .chip{{font-size:.72rem;font-weight:600;background:var(--gray-2);
           border-radius:12px;padding:.15rem .5rem;color:var(--gray-7)}}
    .dc-meta{{font-size:.75rem;color:var(--gray-7);margin-bottom:.85rem}}
    .dc-actions{{display:flex;gap:.4rem;flex-wrap:wrap}}
    .btn{{display:inline-block;padding:.35rem .75rem;border-radius:6px;
          font-size:.78rem;font-weight:600;text-decoration:none;color:#fff}}
    .btn-ttl{{background:#6639ba}}
    .btn-jsonld{{background:#0969da}}
    .btn-gh{{background:var(--gray-9)}}
    .btn-sparql{{background:var(--green)}}
    .empty-state{{padding:2rem;text-align:center;color:var(--gray-7);
                  border:1px dashed var(--gray-3);border-radius:var(--radius)}}

    /* contribute CTA */
    .cta{{background:var(--gray-1);border:1px solid var(--gray-3);border-radius:var(--radius);
          padding:1.5rem;margin-top:2.5rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}}
    .cta p{{flex:1;min-width:200px;font-size:.9rem;color:var(--gray-7)}}
    .btn-cta{{background:var(--green);color:#fff;padding:.55rem 1.2rem;border-radius:6px;
              font-weight:600;font-size:.9rem;text-decoration:none;white-space:nowrap}}
    .btn-cta:hover{{background:var(--green-d);text-decoration:none}}

    footer{{border-top:1px solid var(--gray-3);margin-top:3rem;padding:1.25rem;
            text-align:center;font-size:.81rem;color:var(--gray-7)}}
  </style>
</head>
<body>

<nav>
  <a class="brand" href="/"><img src="https://koetai.semscape.org/static/anableps.jpg" alt="Koetai">Koetai <span>FAIR Data Points</span></a>
  <a href="/">Home</a>
  <a href="/sparql-demo/">SPARQL</a>
  <a href="/ga4gh-rare-disease-trajectories/">BYOD Event</a>
  <div class="spacer"></div>
  <a href="https://github.com/{GITHUB_REPO}" target="_blank">GitHub ↗</a>
</nav>

<div class="band">
  <h1>Rare Disease Datasets</h1>
  <p class="lead">
    Community-contributed, FAIR-compliant disease trajectory datasets from GA4GH biohackathon sessions.
    Each disease gets its own versioned dataset — machine-readable in RDF Turtle and JSON-LD,
    queryable via SPARQL, and ready to use as input for your hackathon.
  </p>
  <div class="badges">
    <span class="badge badge-green">{n} disease dataset{"s" if n != 1 else ""}</span>
    <span class="badge badge-blue">CC BY 4.0</span>
    <span class="badge badge-gray">Updated {TODAY}</span>
    <span class="badge badge-gray">git-versioned</span>
  </div>
</div>

<div class="page">

  <!-- machine-readable access -->
  <div class="access-panel">
    <div>
      <h3>Load this index</h3>
      <pre><code># Python (rdflib)
from rdflib import Graph
g = Graph()
g.parse("{FDP_BASE_URL}/diseases/index.ttl")</code></pre>
      <pre><code># R (rdflib)
library(rdflib)
rdf &lt;- rdf_parse("{FDP_BASE_URL}/diseases/index.ttl",
                 format="turtle")</code></pre>
      <pre><code># curl
curl {FDP_BASE_URL}/diseases/index.ttl</code></pre>
      <div class="access-links">
        <a href="index.ttl"     class="btn-dl btn-ttl">index.ttl</a>
        <a href="index.jsonld"  class="btn-dl btn-jsonld">index.jsonld</a>
        <a href="/sparql-demo/" class="btn-dl btn-sparql">Open SPARQL demo</a>
      </div>
    </div>
    <div>
      <h3>Query all diseases at once</h3>
      <pre><code>PREFIX dcat:    &lt;https://www.w3.org/ns/dcat#&gt;
PREFIX dcterms: &lt;http://purl.org/dc/terms/&gt;
PREFIX ordo:    &lt;http://www.orpha.net/ORDO/Orphanet_&gt;

# List all diseases + their ORDO ID
SELECT ?disease ?title ?ordo WHERE {{
  ?disease a dcat:Dataset ;
           dcterms:title ?title .
  OPTIONAL {{ ?disease dcterms:subject ?ordo .
    FILTER(STRSTARTS(STR(?ordo),
      "http://www.orpha.net")) }}
}}</code></pre>
      <div class="access-links">
        <a href="/sparql-demo/" class="btn-dl btn-sparql">Run in SPARQL demo →</a>
      </div>
    </div>
  </div>

  <!-- disease cards -->
  <h2>Disease datasets ({n})</h2>
  <p class="section-intro">Each card links to a standalone, versioned FAIR dataset for that disease.</p>
  <div class="disease-grid">
{cards_html}
  </div>

  <!-- contribute CTA -->
  <div class="cta">
    <p>Missing a disease? Submit a case via the BYOD web form — it takes 5 minutes and only requires an ORCID login. Your submission becomes a versioned FAIR dataset within 60 seconds.</p>
    <a href="https://byod-form-receiver.andra-76d.workers.dev/forms/disease-case" class="btn-cta">
      Submit a disease case
    </a>
  </div>

</div>

<footer>
  <a href="/">StaticFDP</a> ·
  <a href="/ga4gh-rare-disease-trajectories/">BYOD Event</a> ·
  <a href="/sparql-demo/">SPARQL Demo</a> ·
  <a href="https://github.com/{GITHUB_REPO}" target="_blank">GitHub</a> ·
  Data under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
</footer>

</body>
</html>
"""


# ── Flat submissions.ttl (backward-compatible) ────────────────────────────────

def make_submissions_ttl(all_cases: list[dict]) -> str:
    lines = [
        TTL_PREFIXES,
        f"# Flat community submissions index",
        f"# Auto-generated {TODAY} | {len(all_cases)} case(s)",
        f"# Source: https://github.com/{GITHUB_REPO}/issues?q=label%3Adisease-case",
        "",
    ]
    for issue in all_cases:
        body      = issue.get("body") or ""
        number    = issue["number"]
        created   = issue["created_at"][:10]
        name      = section(body, "Disease name") or issue.get("title", f"Case #{number}")
        ids_raw   = section(body, "Disease identifiers")
        narrative = section(body, "Disease narrative")
        contrib   = section(body, "Contributor")
        registry  = section(body, "Registry or data source")
        orcid_id  = parse_orcid(body)
        ids       = parse_disease_ids(ids_raw)
        subj      = f"<{FDP_BASE_URL}/fdp/submissions/{number}>"
        lines.append(f"{subj} a dcat:Dataset ;")
        lines.append(f"    dcterms:title {ttl_literal(name)} ;")
        if narrative:
            lines.append(f"    dcterms:description {ttl_literal(narrative[:500])} ;")
        lines.append(f'    dcterms:created "{created}"^^xsd:date ;')
        lines.append(f"    dcat:landingPage <{issue['html_url']}> ;")
        for _, _, iri, _ in ids:
            lines.append(f"    dcterms:subject <{iri}> ;")
        if registry:
            lines.append(f'    dcat:keyword "{esc(registry)}"@en ;')
        if orcid_id:
            lines.append(f"    dcterms:creator <https://orcid.org/{orcid_id}> ;")
        elif contrib:
            lines.append(f'    dcterms:creator [ foaf:name "{esc(contrib)}" ] ;')
        lines[-1] = lines[-1].rstrip(" ;") + " ."
        lines.append("")
    return "\n".join(lines)


# ── Gap matching ──────────────────────────────────────────────────────────────

def match_gaps_to_disease(gap_issues: list[dict],
                           disease_ids: list[tuple],
                           disease_name: str) -> list[dict]:
    """Return gap issues that mention this disease by ID or name."""
    disease_iris = {iri for _, _, iri, _ in disease_ids}
    name_lower   = disease_name.lower()
    matched = []
    for issue in gap_issues:
        body = (issue.get("body") or "").lower()
        title = (issue.get("title") or "").lower()
        if name_lower and (name_lower in body or name_lower in title):
            matched.append(issue)
            continue
        for _, local, _, _ in disease_ids:
            if local in body or local in title:
                matched.append(issue)
                break
    return matched


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if not GITHUB_TOKEN:
        print("⚠  No GITHUB_TOKEN — anonymous rate limit: 60 req/hr", file=sys.stderr)

    # Fetch all relevant issues
    print("Fetching disease-case issues…")
    case_issues = fetch_issues("disease-case")
    print(f"  {len(case_issues)} disease-case issue(s)")

    print("Fetching ontology-gap issues…")
    onto_gap_issues = fetch_issues("ontology-gap")
    print(f"  {len(onto_gap_issues)} ontology-gap issue(s)")

    print("Fetching data-gap issues…")
    data_gap_issues = fetch_issues("data-gap")
    print(f"  {len(data_gap_issues)} data-gap issue(s)")

    # Group disease-case issues by slug
    groups: dict[str, dict] = {}  # slug → {name, ids, cases, created}

    for issue in case_issues:
        body     = issue.get("body") or ""
        name     = section(body, "Disease name") or re.sub(r'^\[CASE\]\s*', '', issue.get("title", ""), flags=re.IGNORECASE).strip() or f"Disease #{issue['number']}"
        ids_raw  = section(body, "Disease identifiers")
        ids      = parse_disease_ids(ids_raw)
        registry = section(body, "Registry or data source")
        slug     = disease_slug(ids, name)
        created  = issue["created_at"][:10]
        keywords = [kw.strip() for kw in registry.split(',') if kw.strip()] if registry else []

        if slug not in groups:
            groups[slug] = {"name": name, "ids": ids, "cases": [], "created": created, "keywords": set()}
        groups[slug]["cases"].append(issue)
        groups[slug]["keywords"].update(keywords)
        # Keep earliest created date
        if created < groups[slug]["created"]:
            groups[slug]["created"] = created
        # Merge IDs (prefer highest-priority)
        existing_iris = {i[2] for i in groups[slug]["ids"]}
        for id_entry in ids:
            if id_entry[2] not in existing_iris:
                groups[slug]["ids"].append(id_entry)
                existing_iris.add(id_entry[2])

    print(f"\nBuilding {len(groups)} disease dataset(s)…")

    # Write per-disease files
    diseases_meta = []  # for index

    for slug, grp in sorted(groups.items()):
        name    = grp["name"]
        ids     = grp["ids"]
        cases   = grp["cases"]
        created = grp["created"]
        keywords = sorted(grp["keywords"])

        onto_matched = match_gaps_to_disease(onto_gap_issues, ids, name)
        data_matched = match_gaps_to_disease(data_gap_issues, ids, name)

        print(f"  [{slug}] {name} — {len(cases)} case(s), {len(onto_matched)} onto-gap(s), {len(data_matched)} data-gap(s)")

        # Write source folder: diseases/{slug}/
        src_dir = BASE / "diseases" / slug
        src_dir.mkdir(parents=True, exist_ok=True)

        (src_dir / "metadata.ttl").write_text(
            make_metadata_ttl(slug, name, ids, len(cases), len(onto_matched) + len(data_matched), keywords, created),
            encoding="utf-8"
        )
        (src_dir / "cases.ttl").write_text(
            make_cases_ttl(slug, name, cases), encoding="utf-8"
        )
        (src_dir / "gaps.ttl").write_text(
            make_gaps_ttl(slug, name, onto_matched, data_matched), encoding="utf-8"
        )
        (src_dir / "README.md").write_text(
            make_readme(slug, name, ids, cases, onto_matched, data_matched, created),
            encoding="utf-8"
        )

        # Aggregate cases.ttl for the public docs/ URL
        public_ttl = make_cases_ttl(slug, name, cases)
        public_jsonld = json.dumps({
            "@context": "https://schema.org/",
            "@type": "Dataset",
            "name": name,
            "url": f"{FDP_BASE_URL}/diseases/{slug}/",
            "identifier": f"{primary_display_id(ids)[0]}:{primary_display_id(ids)[1]}" if primary_display_id(ids) else None,
            "dateModified": TODAY,
            "license": "https://creativecommons.org/licenses/by/4.0/",
        }, indent=2, ensure_ascii=False)

        docs_dir = BASE / "docs" / "diseases"
        docs_dir.mkdir(parents=True, exist_ok=True)
        (docs_dir / f"{slug}.ttl").write_text(public_ttl, encoding="utf-8")
        (docs_dir / f"{slug}.jsonld").write_text(public_jsonld, encoding="utf-8")
        (docs_dir / f"{slug}-gaps.ttl").write_text(
            make_gaps_ttl(slug, name, onto_matched, data_matched), encoding="utf-8"
        )

        diseases_meta.append({
            "slug": slug, "name": name, "ids": ids,
            "n_cases": len(cases), "n_onto_gaps": len(onto_matched),
            "n_data_gaps": len(data_matched), "created": created,
            "keywords": keywords,
        })

    # Write index files
    print("\nGenerating index files…")
    docs_dir = BASE / "docs" / "diseases"
    docs_dir.mkdir(parents=True, exist_ok=True)

    index_ttl = make_index_ttl(diseases_meta)
    (docs_dir / "index.ttl").write_text(index_ttl, encoding="utf-8")
    print(f"  → docs/diseases/index.ttl")

    index_jsonld = make_index_jsonld(diseases_meta, TODAY)
    (docs_dir / "index.jsonld").write_text(index_jsonld, encoding="utf-8")
    print(f"  → docs/diseases/index.jsonld")

    index_html = make_index_html(diseases_meta, index_jsonld)
    (docs_dir / "index.html").write_text(index_html, encoding="utf-8")
    print(f"  → docs/diseases/index.html")

    # Backward-compatible flat submissions.ttl
    fdp_dir = BASE / "docs" / "fdp"
    fdp_dir.mkdir(parents=True, exist_ok=True)
    (fdp_dir / "submissions.ttl").write_text(
        make_submissions_ttl(case_issues), encoding="utf-8"
    )
    print(f"  → docs/fdp/submissions.ttl  ({len(case_issues)} case(s))")

    print(f"\n✓ Done — {len(diseases_meta)} disease dataset(s) generated.")


if __name__ == "__main__":
    main()
