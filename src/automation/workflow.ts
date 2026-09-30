import { CHECK_RUNNER } from './runner';

export const WORKFLOW_NAME = 'mcp-checks.yml';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_NAME}`;
export const EXECUTE_STEP = 'Run project checks';
// Le YAML est intégralement détenu par le serveur. Aucun texte du plan n'y est interpolé.
export const MANAGED_WORKFLOW = `# Managed by GitHub MCP, protocol 1. Do not add secrets or deployment steps.
name: MCP project checks
run-name: mcp-checks/\${{ inputs.target_sha || github.sha }}/\${{ inputs.scope || 'quick' }}/\${{ inputs.request_id || 'push' }}
on:
  push:
    branches: ['mcp/**']
  workflow_dispatch:
    inputs:
      target_sha:
        required: true
        type: string
      scope:
        default: quick
        type: string
      target:
        default: ''
        type: string
      request_id:
        required: true
        type: string
permissions:
  contents: read
concurrency:
  group: mcp-checks-\${{ github.event_name }}-\${{ github.event_name == 'push' && github.ref || inputs.target_sha }}-\${{ inputs.scope || 'quick' }}-\${{ inputs.target }}
  cancel-in-progress: \${{ github.event_name == 'push' }}
jobs:
  checks:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - name: Validate request
        env:
          TARGET_SHA: \${{ inputs.target_sha || github.sha }}
        run: '[[ "$TARGET_SHA" =~ ^[a-fA-F0-9]{40}$ ]]'
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ inputs.target_sha || github.sha }}
          persist-credentials: false
          submodules: false
          lfs: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '24.19.0'
          package-manager-cache: false
      - name: ${EXECUTE_STEP}
        env:
          CHECK_SHA: \${{ inputs.target_sha || github.sha }}
          CHECK_SCOPE: \${{ inputs.scope || 'quick' }}
          CHECK_TARGET: \${{ inputs.target }}
          CHECK_REQUEST_ID: \${{ inputs.request_id }}
        shell: bash
        run: |
          node <<'MCP_CHECK_RUNNER'
${CHECK_RUNNER.split('\n').map(line => `          ${line}`).join('\n')}
          MCP_CHECK_RUNNER
`;
