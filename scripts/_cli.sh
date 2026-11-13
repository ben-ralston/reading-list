#!/bin/bash
set -eo pipefail

show-help(){
    echo "USAGE: $(basename "$0") <command> [arguments]"
    echo ""

    # Get all commands
    commands=()
    while IFS='' read -r line; do commands+=("$line"); done < \
        <(compgen -A "function" | grep "run-" | sed "s/run-//")

    # Group commands by category
    echo "Development:"
    for cmd in dev start build lint test; do
        if [[ " ${commands[*]} " =~ " ${cmd} " ]]; then
            printf "  %-20s %s\n" "$cmd" "$(help-for "$cmd")"
        fi
    done

    echo ""
    echo "Database (Supabase):"
    for cmd in db-start db-stop db-reset db-pull-prod seed studio deploy; do
        if [[ " ${commands[*]} " =~ " ${cmd} " ]]; then
            printf "  %-20s %s\n" "$cmd" "$(help-for "$cmd")"
        fi
    done

    echo ""
    echo "Setup:"
    for cmd in initialize; do
        if [[ " ${commands[*]} " =~ " ${cmd} " ]]; then
            printf "  %-20s %s\n" "$cmd" "$(help-for "$cmd")"
        fi
    done
}

name=$1
case "$name" in
    "" | "-h" | "--help" | "help")
        show-help
        ;;
    *)
        shift
        if compgen -A "function" | grep "run-$name" >/dev/null ; then
            # Check for per-command help flag
            if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
                help-detail "$name"
            else
                run-"${name}" "$@"
            fi
        else
            echo "ERROR: run-$name not found."
            exit 123
        fi
        ;;
esac
