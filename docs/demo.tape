# vhs script for the demo GIF: `cd docs && vhs demo.tape` writes public/demo.gif
#
# Prerequisites:
#   * vhs installed (https://github.com/charmbracelet/vhs)
#   * the server installed: npm install -g rustpad-mcp
#     (the inspector CLI mis-parses an `npx -y <pkg>` target, so the tape calls
#     the installed binary directly)
#   * a disposable Rustpad on 127.0.0.1:3030:
#       docker run --rm -dp 127.0.0.1:3030:3030 --name rustpad-demo ekzhang/rustpad
#
# Rules learned the hard way:
#   * inside Hide blocks use vhs's own `Sleep`, never the shell's — shell sleep
#     blocks and the tape ends before any output is recorded
#   * pass the server's environment through the inspector's `-e` flags; the
#     inspector spawns the target with a clean environment
#   * start from the running server, do not record the setup

Output public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "clear" Enter
Sleep 500ms
Show

Type "# rustpad-mcp — MCP server for the Rustpad collaborative editor" Enter
Sleep 1s
Type "# list the 8 tools it exposes" Enter
Sleep 500ms
Type "npx -y @modelcontextprotocol/inspector --cli rustpad-mcp -e RUSTPAD_URL=http://127.0.0.1:3030 --method tools/list | jq -r '.tools[].name'" Enter
Sleep 7s
Type "clear" Enter
Type "# create a pad with initial content and get its share link" Enter
Sleep 500ms
Type "npx -y @modelcontextprotocol/inspector --cli rustpad-mcp -e RUSTPAD_URL=http://127.0.0.1:3030 --method tools/call --tool-name create_document --tool-arg id=demo --tool-arg text='# Meeting notes' | jq -r '.content[0].text'" Enter
Sleep 6s
Type "# append — an OT edit that merges with anyone typing in the browser" Enter
Sleep 500ms
Type "npx -y @modelcontextprotocol/inspector --cli rustpad-mcp -e RUSTPAD_URL=http://127.0.0.1:3030 --method tools/call --tool-name append_to_document --tool-arg id=demo --tool-arg text=$'\\n- ship rustpad-mcp' | jq -r '.content[0].text'" Enter
Sleep 7s
