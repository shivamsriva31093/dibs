#!/usr/bin/env bash
# Launches the five demo agents at once, each a headless Claude Code session with
# its own dibs key and its own working directory. Run scripts/setup-demo.ts first.
#
#   scripts/demo.sh <repo-name>
#
# Each agent's output goes to .demo/<repo>/logs/<agent>.log. Watch the board while they run.
# With DIBS_AGENT_OUTPUT=stream-json the logs hold every step each agent takes, one JSON
# object per line, instead of only its final report.

set -euo pipefail

repo="${1:?usage: scripts/demo.sh <repo-name>}"
[[ "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "\"$repo\" is not a repository name." >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/.demo/$repo"
[ -d "$dir" ] || { echo "No .demo/$repo: run scripts/setup-demo.ts first." >&2; exit 2; }

# The agents run the demo repository's tests, which need a Node that runs TypeScript files directly.
IFS=. read -r node_major node_minor _ <<< "$(node --version 2>/dev/null | sed 's/^v//')"
if [ "${node_major:-0}" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "${node_minor:-0}" -lt 18 ]; }; then
  echo "The demo needs Node 22.18 or later on the PATH; this shell has $(node --version 2>/dev/null || echo none)." >&2
  exit 2
fi

# The working directories are kept outside this repository, so that a git command
# an agent runs before it has cloned its fork cannot land in dibs's own repository.
work_root="$(mktemp -d "${TMPDIR:-/tmp}/dibs-demo-XXXXXX")"
mkdir -p "$dir/logs"

pids=()
for agent in agent-one agent-two agent-three agent-four agent-five; do
  work="$work_root/$agent"
  mkdir -p "$work"
  (
    cd "$work"
    # --setting-sources= starts the agent without the operator's own settings, plugins
    # and CLAUDE.md, so that what it does depends only on its prompt and on dibs.
    GIT_CEILING_DIRECTORIES="$work_root" \
    claude -p "$(cat "$root/scripts/prompts/common.md" "$root/scripts/prompts/$agent.md")" \
      --mcp-config "$dir/$agent.mcp.json" --strict-mcp-config \
      --setting-sources= \
      --permission-mode acceptEdits \
      --allowedTools "mcp__dibs" "Bash(git:*)" "Bash(npm test:*)" "Bash(node --test:*)" "Bash(ls:*)" "Read" "Write" "Edit" "Glob" "Grep" \
      ${DIBS_AGENT_OUTPUT:+--output-format "$DIBS_AGENT_OUTPUT" --verbose} \
      > "$dir/logs/$agent.log" 2>&1
  ) &
  pids+=("$!")
  echo "started $agent (log: .demo/$repo/logs/$agent.log, working in $work)"
  # A short stagger, so that agent-one's claim is in place before agent-two asks for the same paths.
  sleep 4
done

status=0
for pid in "${pids[@]}"; do
  wait "$pid" || status=$?
done
echo "all agents have finished"
exit "$status"
