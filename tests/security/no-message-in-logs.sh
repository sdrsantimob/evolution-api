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
#    não grava em banco — o telefone só viaja dentro do pacote que já carrega as mensagens.
HIST=src/utils/historyPhoneByLid.ts
[ -f "$HIST" ] || { echo "FALHA: $HIST não existe (o guard perdeu o alvo — atualize a lista)"; falhas=$((falhas+1)); }
marcas=$(grep -c '\[WA-34:inicio\]' "$BAILEYS" 2>/dev/null || echo 0)
fins=$(grep -c '\[WA-34:fim\]' "$BAILEYS" 2>/dev/null || echo 0)
if [ "$marcas" -lt 3 ] || [ "$marcas" -ne "$fins" ]; then
    echo "FALHA: marcadores [WA-34:inicio]/[WA-34:fim] ausentes ou desbalanceados em $BAILEYS ($marcas/$fins) — o guard perdeu o alvo"
    falhas=$((falhas+1))
fi
trecho_wa34() { awk '/\[WA-34:inicio\]/{d=1} d{print FILENAME":"FNR": "$0} /\[WA-34:fim\]/{d=0}' "$BAILEYS"; }
acusar "[WA-34] trecho do telefone no histórico escreve em log" < <(trecho_wa34 | grep -vE ':[[:space:]]*//' | grep -E '(logger\.|console\.|process\.stdout|process\.stderr)')
acusar "[WA-34] trecho do telefone no histórico grava em banco ou cache" < <(trecho_wa34 | grep -vE ':[[:space:]]*//' | grep -E '(prismaRepository|\.createMany\(|\.create\(|\.upsert\(|saveOnWhatsappCache|cache\.set)')
acusar "[WA-34] $HIST escreve em log, banco, cache ou arquivo" < <(grep -nE '(logger\.|console\.|process\.stdout|process\.stderr|prisma|fs\.|writeFile|cache)' "$HIST" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*//')

# 6) o guard não pode voltar a contar falha dentro de subshell
if grep -nE '\|[[:space:]]*acusar[[:space:]]' "$0" | grep -vE '^[0-9]+:[[:space:]]*#' | grep -q .; then
    echo "FALHA: este guard chama \`acusar\` no fim de um pipe — a falha não seria contada"
    falhas=$((falhas+1))
fi

[ "$falhas" -eq 0 ] && echo "TUDO OK" && exit 0
exit 1
