bun run build; or exit 1

set -l workspace (pwd)
if test (count $argv) -gt 0
    set workspace $argv[1]
end

begin
    set -lx SOPS_AGE_KEY_FILE "$HOME/.config/sops/age/hetzner-observability.agekey"
    set -l token (sops --decrypt --extract '["data"]["token"]' "$HOME/source/oss/hetzner-observability/secrets/otel-ingest-auth.yaml" | base64 --decode)
    if test -z "$token"
        echo "Cannot load the observability ingestion token." >&2
        exit 1
    end
    set -lx OTEL_EXPORTER_OTLP_HEADERS "Authorization=Bearer $token"
    codium --new-window --user-data-dir "$HOME/.cache/duff-codium-dev" --extensions-dir "$HOME/.cache/duff-codium-extensions" --extensionDevelopmentPath=(pwd) --disable-extensions "$workspace"
end
