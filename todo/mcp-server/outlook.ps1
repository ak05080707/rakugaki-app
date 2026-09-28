# Outlook 2019（デスクトップ版）を COM 経由で読み書きするスクリプト
# index.mjs から呼ばれる。引数は環境変数 OUTLOOK_ARGS（JSON）で受け取り、結果を JSON で出力する。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Out-Json($obj) {
  $json = ConvertTo-Json -InputObject $obj -Depth 5 -Compress
  [Console]::Out.Write($json)
}

try {
  $a = $env:OUTLOOK_ARGS | ConvertFrom-Json
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace('MAPI')

  $bodyLen = if ($a.bodyChars) { [int]$a.bodyChars } else { 300 }
  $limit = if ($a.limit) { [int]$a.limit } else { 30 }
  $since = (Get-Date).AddDays(-[double]$(if ($a.days) { $a.days } else { 7 }))

  function Mail-Obj($m) {
    $body = [string]$m.Body
    $body = ($body -replace '\s+', ' ').Trim()
    if ($body.Length -gt $bodyLen) { $body = $body.Substring(0, $bodyLen) + '…' }
    [ordered]@{
      entryId  = $m.EntryID
      received = $m.ReceivedTime.ToString('yyyy-MM-dd HH:mm')
      from     = $m.SenderName
      fromAddr = $m.SenderEmailAddress
      subject  = $m.Subject
      unread   = [bool]$m.UnRead
      flagged  = ($m.FlagStatus -eq 2)
      body     = $body
    }
  }

  # 受信トレイを新しい順に走査（ロケールに依存しないよう Restrict を使わない）
  function Scan-Inbox($filter) {
    $folder = $ns.GetDefaultFolder(6)  # olFolderInbox
    $items = $folder.Items
    $items.Sort('[ReceivedTime]', $true)
    $res = New-Object System.Collections.ArrayList
    $item = $items.GetFirst()
    while ($item -ne $null -and $res.Count -lt $limit) {
      if ($item.Class -eq 43) {         # olMail
        if ($item.ReceivedTime -lt $since) { break }
        if (& $filter $item) { [void]$res.Add((Mail-Obj $item)) }
      }
      $item = $items.GetNext()
    }
    return ,$res.ToArray()
  }

  switch ($a.action) {
    'recent' {
      $unreadOnly = [bool]$a.unreadOnly
      Out-Json (Scan-Inbox { param($m) (-not $unreadOnly) -or $m.UnRead })
    }
    'flagged' {
      Out-Json (Scan-Inbox { param($m) $m.FlagStatus -eq 2 })
    }
    'search' {
      $q = [string]$a.query
      Out-Json (Scan-Inbox { param($m) ([string]$m.Subject).Contains($q) -or ([string]$m.SenderName).Contains($q) -or ([string]$m.SenderEmailAddress).Contains($q) -or ([string]$m.Body).Contains($q) })
    }
    'calendar' {
      $cal = $ns.GetDefaultFolder(9)    # olFolderCalendar
      $items = $cal.Items
      $items.IncludeRecurrences = $true
      $items.Sort('[Start]')
      $from = (Get-Date).Date.AddDays([double]$(if ($a.offsetDays) { $a.offsetDays } else { 0 }))
      $to = $from.AddDays([double]$(if ($a.days) { $a.days } else { 7 }))
      $f = "[Start] >= '" + $from.ToString('g') + "' AND [Start] < '" + $to.ToString('g') + "'"
      $res = New-Object System.Collections.ArrayList
      foreach ($ap in $items.Restrict($f)) {
        if ($res.Count -ge $limit) { break }
        [void]$res.Add([ordered]@{
          start    = $ap.Start.ToString('yyyy-MM-dd HH:mm')
          end      = $ap.End.ToString('yyyy-MM-dd HH:mm')
          allDay   = [bool]$ap.AllDayEvent
          subject  = $ap.Subject
          location = $ap.Location
        })
      }
      Out-Json $res.ToArray()
    }
    'tasks' {
      $tasks = $ns.GetDefaultFolder(13)  # olFolderTasks
      $res = New-Object System.Collections.ArrayList
      foreach ($t in $tasks.Items) {
        if ($t.Complete) { continue }
        [void]$res.Add([ordered]@{
          entryId = $t.EntryID
          subject = $t.Subject
          due     = if ($t.DueDate.Year -lt 4000) { $t.DueDate.ToString('yyyy-MM-dd') } else { '' }
          body    = ([string]$t.Body).Trim()
        })
        if ($res.Count -ge $limit) { break }
      }
      Out-Json $res.ToArray()
    }
    'moveToDeleted' {
      # 完全削除ではなく「削除済みアイテム」へ移動（Outlook 上で元に戻せる）
      $trash = $ns.GetDefaultFolder(3)   # olFolderDeletedItems
      $res = New-Object System.Collections.ArrayList
      foreach ($id in $a.entryIds) {
        try {
          $m = $ns.GetItemFromID($id)
          $subj = $m.Subject
          [void]$m.Move($trash)
          [void]$res.Add([ordered]@{ entryId = $id; subject = $subj; moved = $true })
        } catch {
          [void]$res.Add([ordered]@{ entryId = $id; moved = $false; error = $_.Exception.Message })
        }
      }
      Out-Json $res.ToArray()
    }
    'setFlag' {
      $m = $ns.GetItemFromID($a.entryId)
      if ($a.done) { $m.FlagStatus = 1 } else { $m.FlagStatus = 2 }   # 1=完了 2=フラグあり
      $m.Save()
      Out-Json ([ordered]@{ entryId = $a.entryId; subject = $m.Subject; flagDone = [bool]$a.done })
    }
    default { throw "unknown action: $($a.action)" }
  }
} catch {
  Out-Json ([ordered]@{ error = $_.Exception.Message })
  exit 1
}
