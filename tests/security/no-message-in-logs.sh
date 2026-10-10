#!/bin/bash
# Guard: o conector NUNCA imprime conteúdo de mensagem, contato ou pacote do
# WhatsApp no log — em nenhum nível e com qualquer LOG_LEVEL. O log do serviço
# fica guardado na plataforma de hospedagem, fora do controle de quem conversa.
#
# Estático: lê os serviços de canal e o envio de webhook e falha se alguma
# chamada de log voltar a receber o objeto da mensagem. Uso:
#   bash tests/security/no-message-in-logs.sh [raiz-do-repositório]
set -u
# Caminho absoluto deste script, resolvido ANTES de mudar de pasta (o item 6 lê o próprio arquivo).
ESTE="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
RAIZ="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$RAIZ" || exit 2

BAILEYS=src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts
META=src/api/integrations/channel/meta/whatsapp.business.service.ts
EVO=src/api/integrations/channel/evolution/evolution.channel.service.ts
WEBHOOK=src/api/integrations/event/webhook/webhook.controller.ts
falhas=0

for f in "$BAILEYS" "$META" "$EVO" "$WEBHOOK"; do
    [ -f "$f" ] || { echo "FALHA: $f não existe (o guard perdeu o alvo — atualize a lista)"; falhas=$((falhas+1)); }
done

LOG='(logger\.(log|info|warn|error|verbose|debug)|console\.[a-z]+)\('
OBJETO='(messageRaw|received|messages|packet|stanza|contact|contacts|args|content|webhookData)'

# ⚠️ `acusar` é SEMPRE chamada com `< <(comando)`, nunca no fim de um `comando | acusar`:
# no fim de um pipe o bash roda a função num subshell e o contador `falhas` se perde — o
# guard imprimia FALHA e saía 0 ("TUDO OK"). Foi assim de 08/10/2026 até esta correção.
acusar() { # $1 = descrição · stdin = linhas achadas
    local achado
    achado=$(cat)
    [ -z "$achado" ] && return 0
    echo "FALHA: $1"
    echo "$achado" | cut -c1-200 | sed 's/^/    /'
    falhas=$((falhas+1))
}

# 1) impressão direta (fora do logger, ignora LOG_LEVEL) nos arquivos de canal.
#    console.error de erro técnico segue permitido.
acusar "console.log/info/debug/warn nos serviços de canal (imprime com qualquer LOG_LEVEL)" < <(grep -nE 'console\.(log|info|debug|dir|warn|table)\(' "$BAILEYS" "$META" "$EVO" "$WEBHOOK" 2>/dev/null)

# 2) o objeto da mensagem como argumento de uma chamada de log, em qualquer nível
acusar "objeto de mensagem/contato/pacote passado direto para o log" < <(grep -nE "${LOG}${OBJETO}[,)]" "$BAILEYS" "$META" "$EVO" "$WEBHOOK" 2>/dev/null)
acusar "objeto de mensagem/contato/pacote como argumento extra do log" < <(grep -nE "${LOG}[^)]*,[[:space:]]*${OBJETO}[,)]" "$BAILEYS" "$META" "$EVO" "$WEBHOOK" 2>/dev/null)
acusar "mensagem enviada passada direto para o log" < <(grep -HnE "${LOG}messageSent[,)]" "$BAILEYS" 2>/dev/null)

# 3) objeto serializado dentro de uma chamada de log
acusar "JSON.stringify dentro de chamada de log (serializa o objeto inteiro)" < <(grep -nE "${LOG}.*JSON\.stringify\(" "$BAILEYS" "$META" "$EVO" "$WEBHOOK" 2>/dev/null)

# 4) o log de webhook (LOG_LEVEL=WEBHOOKS) não leva o corpo nem a chave
acusar "log de webhook com o corpo da mensagem ou a chave" < <(grep -nE -A5 'const logData = \{' "$WEBHOOK" 2>/dev/null | grep -E 'webhookData,|[^a-zA-Z_.]data[,:]|apikey')

# 5) [WA-34] o trecho que anexa o telefone às mensagens do histórico não escreve em log e
#    não grava em banco, cache nem arquivo — o telefone só fica na memória da conexão e dentro
#    do pacote que já carrega as mensagens.
HIST=src/utils/historyPhoneByLid.ts
[ -f "$HIST" ] || { echo "FALHA: $HIST não existe (o guard perdeu o alvo — atualize a lista)"; falhas=$((falhas+1)); }
# `grep -c` sai 1 quando conta zero; a contagem é lida sem `|| echo`, para o zero não virar "0\n0".
marcas=$(grep -c '\[WA-34:inicio\]' "$BAILEYS" 2>/dev/null); marcas=${marcas:-0}
fins=$(grep -c '\[WA-34:fim\]' "$BAILEYS" 2>/dev/null); fins=${fins:-0}
case "$marcas$fins" in *[!0-9]*) marcas=0; fins=0 ;; esac
if [ "$marcas" -lt 4 ] || [ "$marcas" -ne "$fins" ]; then
    echo "FALHA: marcadores [WA-34:inicio]/[WA-34:fim] ausentes ou desbalanceados em $BAILEYS ($marcas/$fins) — o guard perdeu o alvo"
    falhas=$((falhas+1))
fi
# Linhas do trecho marcado, sem as que são só comentário (âncora em arquivo:linha: — um `://`
# no meio do código não conta como comentário).
trecho_wa34() {
    awk '/\[WA-34:inicio\]/{d=1} d{print FILENAME":"FNR": "$0} /\[WA-34:fim\]/{d=0}' "$BAILEYS" \
        | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//'
}
GRAVA='(prismaRepository|\.createMany\(|\.create\(|\.upsert\(|\.update(Many)?\(|saveOnWhatsappCache|storeLIDPNMappings|\.hSet\(|cache\.set|writeFile|appendFile)'
acusar "[WA-34] trecho do telefone no histórico escreve em log" < <(trecho_wa34 | grep -E '(logger\.|console\.|process\.stdout|process\.stderr)')
acusar "[WA-34] trecho do telefone no histórico grava em banco, cache ou arquivo" < <(trecho_wa34 | grep -E "$GRAVA")
acusar "[WA-34] $HIST escreve em log, banco, cache ou arquivo" < <(grep -niE '(logger\.|console\.|process\.stdout|process\.stderr|prisma|fs\.|writeFile|appendFile|nodecache|redis|\.hSet\()' "$HIST" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*//')
# Fora do trecho marcado: nenhuma chamada de log, em nenhum dos arquivos de canal, pode levar
# o telefone anexado, o livro de pares ou o lote de mensagens do histórico.
acusar "[WA-34] chamada de log leva o telefone anexado, os pares ou o lote do histórico" < <(grep -nE "${LOG}[^\n]*(remoteJidAlt|historyPhoneBook|phoneByLid|phoneNumber|messagesRaw|lidsWithoutPhone)" "$BAILEYS" "$META" "$EVO" "$WEBHOOK" 2>/dev/null)

# 7) [WA-37] a consulta "número → identificador" não escreve em log, não grava em banco, cache,
#    arquivo ou sessão, e NÃO usa o caminho da biblioteca que grava o par (`lidMapping`).
LIDLOOKUP=src/utils/lidLookup.ts
ROTAS=src/api/routes/chat.router.ts
CONTROLE=src/api/controllers/chat.controller.ts
for f in "$LIDLOOKUP" "$ROTAS" "$CONTROLE"; do
    [ -f "$f" ] || { echo "FALHA: $f não existe (o guard perdeu o alvo — atualize a lista)"; falhas=$((falhas+1)); }
done
# Linhas dos trechos marcados [WA-37], sem as que são só comentário.
trecho_wa37() { # $1 = arquivo
    awk '/\[WA-37:inicio\]/{d=1} d{print FILENAME":"FNR": "$0} /\[WA-37:fim\]/{d=0}' "$1" \
        | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//'
}
marcas_wa37() { # $1 = arquivo · $2 = mínimo de trechos
    local ini fim
    ini=$(grep -c '\[WA-37:inicio\]' "$1" 2>/dev/null); ini=${ini:-0}
    fim=$(grep -c '\[WA-37:fim\]' "$1" 2>/dev/null); fim=${fim:-0}
    case "$ini$fim" in *[!0-9]*) ini=0; fim=0 ;; esac
    if [ "$ini" -lt "$2" ] || [ "$ini" -ne "$fim" ]; then
        echo "FALHA: marcadores [WA-37:inicio]/[WA-37:fim] ausentes ou desbalanceados em $1 ($ini/$fim) — o guard perdeu o alvo"
        falhas=$((falhas+1))
    fi
}
marcas_wa37 "$BAILEYS" 2
marcas_wa37 "$ROTAS" 1
marcas_wa37 "$CONTROLE" 1
ESCREVE='(logger\.|console\.|process\.stdout|process\.stderr)'
GUARDA_WA37='(prisma|Repository|\.createMany\(|\.create\(|\.upsert\(|\.update(Many)?\(|OnWhatsappCache|lidMapping|LIDPNMapping|getLIDsForPNs|getLIDForPN|keys\.set|\.hSet\(|cache\.(set|get)|NodeCache|redis|fs\.|writeFile|appendFile|sendDataWebhook|dataValidate)'
for f in "$BAILEYS" "$ROTAS" "$CONTROLE"; do
    acusar "[WA-37] trecho da consulta do identificador escreve em log ($f)" < <(trecho_wa37 "$f" | grep -E "$ESCREVE")
    acusar "[WA-37] trecho da consulta do identificador grava, usa cache/sessão ou o validador que escreve em log ($f)" < <(trecho_wa37 "$f" | grep -iE "$GUARDA_WA37")
done
acusar "[WA-37] $LIDLOOKUP escreve em log" < <(grep -nE "$ESCREVE" "$LIDLOOKUP" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*//')
acusar "[WA-37] $LIDLOOKUP grava, usa cache/sessão ou o caminho que guarda o par" < <(grep -niE "$GUARDA_WA37" "$LIDLOOKUP" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*//')
# O arquivo da consulta só depende da biblioteca do WhatsApp (nada de banco, cache ou configuração).
acusar "[WA-37] $LIDLOOKUP importa algo além da biblioteca do WhatsApp" < <(grep -nE "^import .* from '" "$LIDLOOKUP" 2>/dev/null | grep -vE "from 'baileys';")
# A consulta é UMA por vez: nenhum caminho novo pode aceitar lista de números para ela.
acusar "[WA-37] a consulta do identificador aceita lista de números" < <(grep -nE 'numbers' "$LIDLOOKUP" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*//')
# Fora dos trechos marcados, ninguém mais chama a consulta direta ao WhatsApp nos serviços de canal.
fora_wa37=$(awk '/\[WA-37:inicio\]/{d=1} !d{print FILENAME":"FNR": "$0} /\[WA-37:fim\]/{d=0}' "$BAILEYS" | grep -E 'executeUSyncQuery|lidLookupGate')
acusar "[WA-37] consulta direta ao WhatsApp usada fora do trecho marcado" < <(printf '%s' "$fora_wa37")

# 6) o guard não pode voltar a contar falha dentro de subshell
if grep -nE '\|[[:space:]]*acusar[[:space:]]' "$ESTE" | grep -vE '^[0-9]+:[[:space:]]*#' | grep -q .; then
    echo "FALHA: este guard chama \`acusar\` no fim de um pipe — a falha não seria contada"
    falhas=$((falhas+1))
fi

[ "$falhas" -eq 0 ] && echo "TUDO OK" && exit 0
exit 1
