Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "/app/conversations/6ac09513f6db3e6a7139902d/repos/pc"
sh.Run """/usr/bin/node"" ""/app/conversations/6ac09513f6db3e6a7139902d/repos/pc/server/cli.js"" update --if-closed", 0, True
