Option Explicit
' Stop the panel and all of its tunnels without showing a console window.
Dim shell, fso, dir, rc
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
' Do not append to panel.log: the running panel keeps that file open.
rc = shell.Run("cmd /c node.exe server.js --stop > panel-stop.log 2>&1", 0, True)
If rc <> 0 Then
  MsgBox "The panel is not running, or it could not be stopped." & vbCrLf & "See panel-stop.log for details.", 48, "magpie SSH Tunnel Panel"
End If
