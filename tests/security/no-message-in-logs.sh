#!/bin/bash
# Guard: o conector NUNCA imprime conteúdo de mensagem, contato ou pacote do
# WhatsApp no log — em nenhum nível e com qualquer LOG_LEVEL. O log do serviço
# fica guardado na plataforma de hospedagem, fora do controle de quem conversa.
#
# Estático: lê os serviços de canal e o envio de webhook e falha se alguma
# chamada de log voltar a receber o objeto da mensagem. Uso:
#   bash tests/security/no-message-in-logs.sh [raiz-do-repositório]
set -u
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
grep -nE 'console\.(log|info|debug|dir|warn|table)\(' "$BAILEYS" "$META" "$EVO" "$WEBHOOK" 2>/dev/null \
    | acusar "console.log/info/debug/warn nos serviços de canal (imprime com qualquer LOG_LEVEL)"

# 2) o objeto da mensagem como argumento de uma chamada de log, em qualquer nível
grep -nE "${LOG}${OBJETO}[,)]" "$BAILEYS" "$META" "$EVO" "$WEBHOOK" 2>/dev/null \
    | acusar "objeto de mensagem/contato/pacote passado direto para o log"
grep -nE "${LOG}[^)]*,[[:space:]]*${OBJETO}[,)]" "$BAILEYS" "$META" "$EVO" "$WEBHOOK" 2>/dev/null \
    | acusar "objeto de mensagem/contato/pacote como argumento extra do log"
grep -HnE "${LOG}messageSent[,)]" "$BAILEYS" 2>/dev/null \
    | acusar "mensagem enviada passada direto para o log"

# 3) objeto serializado dentro de uma chamada de log
grep -nE "${LOG}.*JSON\.stringify\(" "$BAILEYS" "$META" "$EVO" "$WEBHOOK" 2>/dev/null \
    | acusar "JSON.stringify dentro de chamada de log (serializa o objeto inteiro)"

# 4) o log de webhook (LOG_LEVEL=WEBHOOKS) não leva o corpo nem a chave
grep -nE -A5 'const logData = \{' "$WEBHOOK" 2>/dev/null | grep -E 'webhookData,|[^a-zA-Z_.]data[,:]|apikey' \
    | acusar "log de webhook com o corpo da mensagem ou a chave"

[ "$falhas" -eq 0 ] && echo "TUDO OK" && exit 0
exit 1
