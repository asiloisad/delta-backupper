#!/bin/sh
# Per-user CLI integration. Never changes shell profiles or overwrites a command.
set -eu

fail() { printf '%s\n' "Delta Backupper: $*" >&2; exit 1; }
usage() { printf '%s\n' 'Usage: sh install-cli.sh install|uninstall [--bin-dir ABSOLUTE_DIRECTORY] [--dry-run]'; }
mode=${1:-}
case "$mode" in install|uninstall) shift ;; -h|--help) usage; exit 0 ;; *) usage >&2; exit 2 ;; esac
[ -n "${HOME:-}" ] || fail 'HOME is not set.'
bin_dir=$HOME/.local/bin
dry_run=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir) [ "$#" -ge 2 ] || fail '--bin-dir requires an absolute directory.'; bin_dir=$2; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) fail "Unknown option: $1" ;;
  esac
done
case "$bin_dir" in /*) ;; *) fail '--bin-dir must be absolute.' ;; esac
while [ "${bin_dir%/}" != "$bin_dir" ]; do bin_dir=${bin_dir%/}; done
[ -n "$bin_dir" ] || fail 'The filesystem root cannot be a command directory.'
case "$bin_dir" in */../*|*/..|*/./*|*/.) fail 'The command directory must not contain dot path segments.' ;; esac
if [ -d "$bin_dir" ]; then bin_dir=$(CDPATH= cd -P "$bin_dir" && pwd -P); fi
[ "$bin_dir" != / ] || fail 'The filesystem root cannot be a command directory.'
# Newlines would make diagnostics and the result ambiguous; spaces and Unicode work.
case "$bin_dir" in *'
'*) fail 'The command directory must not contain a newline.' ;; esac
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)
case "$(uname -s)" in
  Darwin)
    case "$script_dir" in /Volumes/*) fail 'Copy Delta Backupper.app off the disk image before installing its command.' ;; esac
    cli=$script_dir/MacOS/delta ;;
  Linux)
    [ -z "${APPIMAGE:-}" ] || fail 'Extract the tar.gz package to a permanent directory before installing its command.'
    cli=$script_dir/bin/delta ;;
  *) fail 'This helper supports Linux and macOS.' ;;
esac
command_path=$bin_dir/delta
owned=false
if [ -L "$command_path" ]; then
  [ "$(readlink "$command_path")" = "$cli" ] || fail "Another command owns $command_path; it was left unchanged."
  owned=true
elif [ -e "$command_path" ]; then
  fail "Another command owns $command_path; it was left unchanged."
fi
if [ "$mode" = install ]; then
  [ -f "$cli" ] && [ -x "$cli" ] || fail "The packaged executable is missing or not executable: $cli"
  if [ "$owned" = false ] && [ "$dry_run" = false ]; then
    mkdir -p "$bin_dir"
    # ln without -f also protects a command created after the ownership check.
    ln -s "$cli" "$command_path"
  fi
  printf '%s\n' "CLI command: $command_path" "Executable: $cli"
  case :${PATH:-}: in *:"$bin_dir":*) ;; *) printf '%s\n' 'The command directory is not on PATH. Add it in your shell settings or invoke the command by its full path.' ;; esac
else
  if [ "$owned" = true ] && [ "$dry_run" = false ]; then
    # Remove only the exact symlink owned by this application directory.
    [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$cli" ] || fail 'The command changed during uninstallation.'
    rm "$command_path"
  fi
  printf '%s\n' "CLI integration removed: $command_path"
fi
if [ "$dry_run" = true ]; then printf '%s\n' 'Dry run: no files were changed.'; fi
