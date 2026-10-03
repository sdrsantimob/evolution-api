export_env_vars() {
    if [ -f .env ]; then
        while IFS='=' read -r key value; do
            if [[ -z "$key" || "$key" =~ ^\s*# || -z "$value" ]]; then
                continue
            fi

            key=$(echo "$key" | tr -d '[:space:]')
            value=$(echo "$value" | tr -d '[:space:]')
            value=$(echo "$value" | tr -d "'" | tr -d "\"")

            export "$key=$value"
        done < .env
    else
        echo ".env file not found"
        exit 1
    fi
}


# Devolve a URL com a senha mascarada (usuario:***@host). Os logs de build/deploy
# são lidos por mais gente do que o cofre de variáveis — credencial nunca entra neles.
redact_url() {
    printf '%s' "$1" | sed -E 's#(://[^:/@]*):.*@#\1:***@#'
}
