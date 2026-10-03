#!/bin/bash
# Guard: os scripts de Docker NUNCA podem imprimir credencial do banco nos logs
# de build/deploy. Roda com URL fictícia e `npm` falso; falha se a senha aparecer
# ou se alguém reintroduzir um echo/printf/set -x de variável de conexão.
set -u
cd "$(dirname "$0")/../../.." || exit 2

SENHA='SenhaFicticia@123!'
URL="postgresql://usuario_x:${SENHA}@host.exemplo:5432/db?sslmode=require"
falhas=0

# 1) comportamento: roda os scripts reais e procura a senha na saída
tmp=$(mktemp -d); mkdir -p "$tmp/bin"
printf '#!/bin/bash\necho "[npm falso] $*"\n' > "$tmp/bin/npm"; chmod +x "$tmp/bin/npm"
for s in deploy_database generate_database; do
    saida=$(PATH="$tmp/bin:$PATH" DOCKER_ENV=true DATABASE_PROVIDER=postgresql DATABASE_URL="$URL" \
        DATABASE_CONNECTION_URI="$URL" /bin/bash -c ". ./Docker/scripts/$s.sh" 2>&1)
    if grep -qF -- "$SENHA" <<<"$saida" || grep -qF -- "123!" <<<"$saida"; then
        echo "FALHA: $s.sh imprimiu a senha do banco"; falhas=$((falhas+1))
    elif ! grep -q "usuario_x:\*\*\*@host.exemplo" <<<"$saida"; then
        echo "FALHA: $s.sh não imprimiu a URL mascarada (diagnóstico perdido)"; falhas=$((falhas+1))
    else
        echo "ok: $s.sh não vaza a senha"
    fi
done
rm -rf "$tmp"

# 2) estático: nenhum echo/printf/set -x de variável de conexão fora do redact_url
# (dois padrões: variável de conexão impressa sem passar pelo redact_url, e set -x)
if grep -nE '(echo|printf)[^|]*\$\{?(DATABASE_URL|DATABASE_CONNECTION_URI|CACHE_REDIS_URI|AUTHENTICATION_API_KEY)\b' Docker/scripts/*.sh runWithProvider.js 2>/dev/null \
    | grep -v 'redact_url'; then
    echo "FALHA: variável de conexão impressa sem redact_url"; falhas=$((falhas+1))
fi
if grep -nE '(^|[[:space:]])set[[:space:]]+-[a-z]*x' Docker/scripts/*.sh; then
    echo "FALHA: 'set -x' imprimiria variáveis expandidas"; falhas=$((falhas+1))
fi

[ "$falhas" -eq 0 ] && echo "TUDO OK" && exit 0
exit 1
