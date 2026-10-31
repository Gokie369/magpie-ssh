Option Explicit
' Start the magpie SSH tunnel panel without any console window.
' Output goes to panel.log next to this script; server.js keeps it under 1 MB.
Dim shell, fso, dir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

If shell.Run("cmd /c where node.exe >nul 2>nul", 0, True) <> 0 Then
  MsgBox "Node.js 18 or newer is required." & vbCrLf & "Install it from https://nodejs.org/ and try again.", 16, "magpie SSH Tunnel Panel"
  WScript.Quit 1
End If

shell.CurrentDirectory = dir
' 0 = hidden window, False = do not wait. server.js opens the browser itself.
' server.js writes UTF-8 output to panel.log, trimming old lines to stay under 1 MB.
shell.Run "cmd /c node.exe server.js --log panel.log", 0, False
