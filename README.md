# API Docs Website GitHub Action

Generate a small, self-contained API reference site from OpenAPI, AsyncAPI, and GraphQL schema files, then publish it with GitHub Pages.

The generated site has a searchable navigation sidebar and documents OpenAPI operations and component schemas, AsyncAPI publish/subscribe channels, and GraphQL definitions. It is a single static `index.html` with inline styling and script, so it works at a GitHub Pages project URL without extra base path configuration.

The first version uses a Fumadocs-inspired documentation layout with a small static renderer. This keeps builds self-contained and avoids requiring a Next.js runtime in customer repositories; interactive API playgrounds are not part of this version.

## Reusable Pages workflow

Add a workflow to the library repository:

```yaml
name: API documentation

on:
  push:
    branches: [main]
    paths:
      - "api/**"
      - ".github/workflows/api-docs.yml"
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  publish:
    uses: portpowered/api-docs-website-github-action/.github/workflows/publish.yml@main
    with:
      title: go-ring API Reference
      openapi: api/openapi.yaml
      asyncapi: api/asyncapi.yaml
      discover: false
```

The caller repository must enable GitHub Pages with **GitHub Actions** as the build and deployment source. The reusable workflow checks out the caller's source, generates the site, uploads the Pages artifact, and deploys it.

## Composite action

Use the action in an existing workflow when deployment is managed separately:

```yaml
- uses: portpowered/api-docs-website-github-action@main
  with:
    title: My Library API
    openapi: "api/openapi.yaml, api/admin/*.json"
    asyncapi: api/events.yaml
    graphql: "schema/**/*.graphql"
    discover: false
    output: api-docs-out
```

Inputs accept comma-separated paths or globs relative to `source-directory`. If no paths are given for a type, discovery recognizes OpenAPI and AsyncAPI documents by their `openapi` or `asyncapi` version field and includes `.graphql` and `.gql` files. Discovery skips common dependency and build directories. Set `discover: false` to use only explicitly listed files.

The `output` directory contains `index.html` and can be uploaded as a Pages artifact or hosted on any static file server.
