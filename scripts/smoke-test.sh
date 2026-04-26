#!/usr/bin/env bash
# scripts/smoke-test.sh
# ---------------------
# Fast sanity check for the four diagnostic scripts.
#
# What it covers:
#   - --help exits 0 with usage on stdout for every script.
#   - No-args invocation either prints usage cleanly or exits with a
#     deterministic, non-crashing error code (NO TypeError stack traces,
#     NO unhandled rejections).
#   - --bad-flag rejected with a clean error.
#
# What it does NOT cover:
#   - Live network probes, real seed derivation, real verifier runs.
#     Those are integration tests; this is a smoke test for the CLI surface.
#
# Runs in <2 seconds. Fail = non-zero exit and a list of failed checks.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.." || exit 99

PASS=0
FAIL=0
FAILED_CHECKS=()

run_check() {
  local name="$1"; shift
  local expected_exit="$1"; shift
  local actual_exit
  local output
  output=$("$@" 2>&1)
  actual_exit=$?
  if [ "$actual_exit" -eq "$expected_exit" ]; then
    # Defensive: any node script that crashes with TypeError /
    # ReferenceError / UnhandledPromiseRejection has failed even if the
    # exit code happened to match. Catches the regression class that
    # produced the rpc-reachability-probe zero-args bug.
    if echo "$output" | grep -qE 'TypeError|ReferenceError|UnhandledPromiseRejection|at file://'; then
      FAIL=$((FAIL+1))
      FAILED_CHECKS+=("$name (exit ok but stack trace in output)")
      printf '  FAIL  %s -- exit=%d but output contains a stack trace\n' "$name" "$actual_exit"
      return
    fi
    PASS=$((PASS+1))
    printf '  PASS  %s\n' "$name"
  else
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name (expected exit $expected_exit, got $actual_exit)")
    printf '  FAIL  %s -- expected exit %d, got %d\n' "$name" "$expected_exit" "$actual_exit"
  fi
}

echo "Smoke test: scripts/"
echo "===================="

echo "address-derive.mjs"
run_check "  --help"                  0 node scripts/address-derive.mjs --help
run_check "  no args (prints usage)"  0 node scripts/address-derive.mjs
run_check "  invalid seed"            2 node scripts/address-derive.mjs notavalidseed
run_check "  unknown flag"            2 node scripts/address-derive.mjs --bogus

echo "deploy-verifier.mjs"
run_check "  --help"                  0 node scripts/deploy-verifier.mjs --help
run_check "  no args (exits 2)"       2 node scripts/deploy-verifier.mjs
run_check "  missing manifest path"   2 node scripts/deploy-verifier.mjs /nonexistent/manifest.json

echo "persistent-hash-self-test.mjs"
run_check "  --help"                  0 node scripts/persistent-hash-self-test.mjs --help
# This script may exit 0 (PASS, with or without SDK) or 1 (genuine fail).
# Both are valid no-crash outcomes; we just want it not to TypeError.
output=$(node scripts/persistent-hash-self-test.mjs 2>&1)
exit_code=$?
if [ "$exit_code" -ne 0 ] && [ "$exit_code" -ne 1 ]; then
  FAIL=$((FAIL+1))
  FAILED_CHECKS+=("persistent-hash-self-test no args (exit=$exit_code, expected 0 or 1)")
  printf '  FAIL  no args -- exit=%d (expected 0 or 1)\n' "$exit_code"
elif echo "$output" | grep -qE 'TypeError|ReferenceError|UnhandledPromiseRejection'; then
  FAIL=$((FAIL+1))
  FAILED_CHECKS+=("persistent-hash-self-test no args (stack trace in output)")
  printf '  FAIL  no args -- stack trace in output\n'
else
  PASS=$((PASS+1))
  printf '  PASS    no args (exit=%d)\n' "$exit_code"
fi
run_check "  unexpected positional arg" 2 node scripts/persistent-hash-self-test.mjs garbage

echo "rpc-reachability-probe.mjs"
run_check "  --help"                  0 node scripts/rpc-reachability-probe.mjs --help
run_check "  no args (exits 2)"       2 node scripts/rpc-reachability-probe.mjs
run_check "  invalid scheme"          2 node scripts/rpc-reachability-probe.mjs ftp://example.com

echo
if [ "$FAIL" -eq 0 ]; then
  printf 'Smoke test: %d passed, 0 failed.\n' "$PASS"
  exit 0
else
  printf 'Smoke test: %d passed, %d FAILED.\n' "$PASS" "$FAIL"
  printf 'Failed checks:\n'
  for c in "${FAILED_CHECKS[@]}"; do printf '  - %s\n' "$c"; done
  exit 1
fi
