#!/usr/bin/env bash
# 探测应用身份（bot）在每个操作上缺哪些 scope。
# 原理：typed 域命令在鉴权层就被拦，返回 missing_scopes + console_url。
# 写操作故意用 bogus 目标 —— 鉴权先于资源校验，拿得到 scope 错误，又不会真写。
#
# 坑：Git Bash 会把 /open-apis/... 这种裸路径转成 Windows 路径，
# 所以只能用 typed 命令（走 --flag），不能用 `lark-cli api GET /open-apis/...`。

NODE="C:/Users/Administrator/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe"
RJ="C:/Users/Administrator/.workbuddy/binaries/node/cli-connector-packages/node_modules/@larksuite/cli/scripts/run.js"
BASE="MnsVbAsGkaPRZDsmBMYc9psgnwe"
TABLE="tblegbF21YnI5Avs"
BB="bogusbogusbogusbogus"
BT="tblbogus"

run() {
  local label="$1"; shift
  printf '### %s\n' "$label"
  "$NODE" "$RJ" "$@" 2>&1 \
    | grep -oE '"missing_scopes": \[[^]]*\]|"message": "[^"]*"|"console_url": "[^"]*"' \
    | head -3
  echo ""
}

echo "================ IM（卡片 / 消息） ================"
run "im +messages-send      发卡片/文本" \
  im +messages-send --user-id ou_bogus --text probe --as bot
run "im messages patch      原地更新卡片" \
  im messages patch --message-id om_bogus --data '{"content":"{}"}' --as bot
run "im pins create         置顶面板卡" \
  im pins create --data '{"message_id":"om_bogus"}' --as bot

echo "================ 多维表格：读 ================"
run "base +table-list       列全部表" \
  base +table-list --base-token "$BASE" --as bot
run "base +record-list      读记录" \
  base +record-list --base-token "$BASE" --table-id "$TABLE" --as bot
run "base +field-list       读字段" \
  base +field-list --base-token "$BASE" --table-id "$TABLE" --as bot

echo "================ 多维表格：写 ================"
run "base +record-batch-create  批量插入" \
  base +record-batch-create --base-token "$BB" --table-id "$BT" \
  --json '{"create_records":[{"标题":"probe"}]}' --as bot
run "base +record-batch-update  批量更新" \
  base +record-batch-update --base-token "$BB" --table-id "$BT" \
  --json '{"update_records":{"recbogus":{"标题":"probe"}}}' --as bot
run "base +record-delete       删记录" \
  base +record-delete --base-token "$BB" --table-id "$BT" --record-id recbogus --yes --as bot
run "base +field-create        加字段" \
  base +field-create --base-token "$BB" --table-id "$BT" \
  --json '{"name":"probe","type":"text"}' --as bot
run "base +field-update        改字段" \
  base +field-update --base-token "$BB" --table-id "$BT" --field-id fldbogus \
  --json '{"name":"probe"}' --as bot
run "base +table-create        建表" \
  base +table-create --base-token "$BB" --name probe \
  --fields '[{"name":"T","type":"text"}]' --as bot
run "base +base-create         建多维表格" \
  base +base-create --name probe --as bot
