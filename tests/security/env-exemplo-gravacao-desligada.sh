#!/bin/bash
# Guard: o Dockerfile copia .env.example para .env, e o dotenv usa esse valor
# sempre que a variável estiver em branco no painel. Toda chave de gravação no
# banco do conector (DATABASE_SAVE_*) tem de nascer DESLIGADA aqui — senão uma
# variável esquecida religa, sem ninguém ver, a gravação de agenda, conversas,
# etiquetas ou da lista "tem WhatsApp" fora do cofre do sistema ([SEG-84]).
# Quem precisa de uma gravação liga explicitamente no ambiente.
set -u
cd "$(dirname "$0")/../.." || exit 2

arq=.env.example
falhas=0

if ! grep -qF "COPY ./.env.example ./.env" Dockerfile; then
    echo "AVISO: o Dockerfile não copia mais $arq — revise se esta trava ainda protege algo"
fi

chaves=$(grep -E '^DATABASE_SAVE_[A-Z_]+=' "$arq" | grep -v '_DAYS=')
if [ -z "$chaves" ]; then
    echo "FALHA: nenhuma chave DATABASE_SAVE_* encontrada em $arq"; exit 1
fi

while IFS= read -r linha; do
    nome=${linha%%=*}
    valor=${linha#*=}
    if [ "$valor" != "false" ]; then
        echo "FALHA: $nome=$valor em $arq (tem de ser false)"; falhas=$((falhas+1))
    else
        echo "ok: $nome desligada"
    fi
done <<<"$chaves"

[ "$falhas" -eq 0 ] && echo "TUDO OK" && exit 0
exit 1
