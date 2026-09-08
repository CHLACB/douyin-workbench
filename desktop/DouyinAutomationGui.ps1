Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Script:ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Script:CliPath = Join-Path $Script:ProjectRoot "src\cli.js"
$Script:LastState = $null
$Script:Buttons = @()

function Quote-Arg {
  param([string]$Value)
  if ($null -eq $Value) { return '""' }
  if ($Value -notmatch '[\s";]') { return $Value }
  return '"' + ($Value -replace '\\', '\\' -replace '"', '\"') + '"'
}

function Invoke-NodeJson {
  param([string[]]$Arguments)

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = "node"
  $allArgs = @((Quote-Arg $Script:CliPath)) + ($Arguments | ForEach-Object { Quote-Arg $_ })
  $psi.Arguments = ($allArgs -join " ")
  $psi.WorkingDirectory = $Script:ProjectRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $process = [System.Diagnostics.Process]::Start($psi)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()

  if ($process.ExitCode -ne 0) {
    throw "命令失败: node $($psi.Arguments)`r`n$stderr`r`n$stdout"
  }

  $jsonText = $stdout.Trim()
  $match = [regex]::Match($jsonText, '(?s)\{.*\}\s*$')
  if ($match.Success) {
    $jsonText = $match.Value
  }

  try {
    return $jsonText | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{
      ok = $false
      raw = $stdout
      error = "输出不是 JSON"
    }
  }
}

function Format-Json {
  param($Value)
  try {
    return ($Value | ConvertTo-Json -Depth 20)
  } catch {
    return [string]$Value
  }
}

function Add-Log {
  param([string]$Message)
  $timestamp = Get-Date -Format "HH:mm:ss"
  $txtLog.AppendText("[$timestamp] $Message`r`n")
  $txtLog.SelectionStart = $txtLog.Text.Length
  $txtLog.ScrollToCaret()
}

function Show-Error {
  param([string]$Message)
  try {
    [System.Windows.Forms.MessageBox]::Show(
      $Message,
      "操作失败",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch {
    Add-Log "错误弹窗显示失败：$($_.Exception.Message)"
  }
}

function Set-Busy {
  param([bool]$Busy)
  foreach ($button in $Script:Buttons) {
    $button.Enabled = -not $Busy
  }
  $form.Cursor = if ($Busy) {
    [System.Windows.Forms.Cursors]::WaitCursor
  } else {
    [System.Windows.Forms.Cursors]::Default
  }
}

function Run-Task {
  param(
    [string]$Title,
    [scriptblock]$Work,
    [scriptblock]$Done
  )

  Set-Busy $true
  Add-Log "开始：$Title"

  $worker = [System.ComponentModel.BackgroundWorker]::new()
  $worker.add_DoWork({
    param($sender, $event)
    try {
      $event.Result = [pscustomobject]@{
        ok = $true
        value = & $Work
      }
    } catch {
      $event.Result = [pscustomobject]@{
        ok = $false
        error = $_.Exception.Message
      }
    }
  })
  $worker.add_RunWorkerCompleted({
    param($sender, $event)
    try {
      Set-Busy $false
      $result = $event.Result
      if (-not $result.ok) {
        Add-Log "失败：$Title"
        Add-Log $result.error
        Show-Error $result.error
        return
      }

      Add-Log "完成：$Title"
      if ($Done) {
        & $Done $result.value
      } else {
        Add-Log (Format-Json $result.value)
      }
    } catch {
      Add-Log "任务回调异常：$($_.Exception.Message)"
      Show-Error $_.Exception.Message
    }
  })
  $worker.RunWorkerAsync()
}

function Get-CommonArgs {
  return @()
}

function Get-Terms {
  $value = $txtTerms.Text.Trim()
  if ([string]::IsNullOrWhiteSpace($value)) {
    return "情感;日常vlog;恋爱技巧"
  }
  return $value
}

function Get-Number {
  param(
    [System.Windows.Forms.TextBox]$TextBox,
    [int]$Fallback
  )
  $parsed = 0
  if ([int]::TryParse($TextBox.Text.Trim(), [ref]$parsed) -and $parsed -ge 0) {
    return $parsed
  }
  return $Fallback
}

function Get-WatchArgs {
  $minWatch = Get-Number $txtMinWatch 120000
  $maxWatch = Get-Number $txtMaxWatch 180000
  if ($chkQuick.Checked) {
    $minWatch = 10000
    $maxWatch = 15000
  }
  return @(
    "--cycles", (Get-Number $txtCycles 1),
    "--min-watch-ms", $minWatch,
    "--max-watch-ms", $maxWatch
  )
}

function Get-SearchCycleArgs {
  $minBrowse = Get-Number $txtMinBrowse 120000
  $maxBrowse = Get-Number $txtMaxBrowse 180000
  $minWatch = Get-Number $txtMinWatch 120000
  $maxWatch = Get-Number $txtMaxWatch 180000
  if ($chkQuick.Checked) {
    $minBrowse = 10000
    $maxBrowse = 15000
    $minWatch = 10000
    $maxWatch = 15000
  }
  return @(
    "--terms", (Get-Terms),
    "--searches", (Get-Number $txtSearches 2),
    "--min-browse-ms", $minBrowse,
    "--max-browse-ms", $maxBrowse,
    "--min-watch-ms", $minWatch,
    "--max-watch-ms", $maxWatch
  )
}

function Update-StateUi {
  param($State)
  $Script:LastState = $State

  if (-not $State -or -not $State.ok) {
    $lblCurrent.Text = "当前位置：无法识别"
    $lblNext.Text = "下一步：刷新状态"
    return
  }

  $lblPage.Text = "页面：$($State.page.title)"
  $lblUrl.Text = "地址：$($State.page.url)"
  $lblCurrent.Text = "当前位置：$($State.workflow.current)"
  $lblNext.Text = "下一步：$($State.workflow.nextAction.command) - $($State.workflow.nextAction.reason)"
  $lblSearch.Text = "搜索框：" + ($(if ($State.searchBox.ok) { "可用" } else { "不可用" }))
  $lblVideo.Text = "视频候选：$($State.videoCandidateCount)"
  $lblComment.Text = "评论区：" + ($(if ($State.commentPanel.ok) { "已打开" } else { "未打开/未识别" }))

  $listSteps.Items.Clear()
  foreach ($step in $State.workflow.steps) {
    $item = [System.Windows.Forms.ListViewItem]::new($step.name)
    $item.SubItems.Add($(if ($step.done) { "完成" } else { "未完成" })) | Out-Null
    $item.SubItems.Add($step.id) | Out-Null
    $item.Checked = [bool]$step.done
    $listSteps.Items.Add($item) | Out-Null
  }
}

function Refresh-State {
  Run-Task "刷新状态" {
    $browser = Invoke-NodeJson @("browser", "status")
    if (-not $browser.connected) {
      return [pscustomobject]@{
        ok = $false
        browser = $browser
        message = "Chrome 调试会话未连接"
      }
    }
    return Invoke-NodeJson @("douyin", "inspect")
  } {
    param($result)
    if ($result.ok -eq $false -and $result.browser) {
      $lblCurrent.Text = "当前位置：Chrome 未连接"
      $lblNext.Text = "下一步：点击打开浏览器"
      Add-Log (Format-Json $result)
      return
    }
    Update-StateUi $result
    Add-Log (Format-Json $result.workflow)
  }
}

function Invoke-Action {
  param(
    [string]$Title,
    [string[]]$Args,
    [bool]$RefreshAfter = $true
  )
  Run-Task $Title {
    Invoke-NodeJson $Args
  } {
    param($result)
    Add-Log (Format-Json $result)
    if ($RefreshAfter) {
      Refresh-State
    }
  }
}

function Invoke-Next {
  if (-not $Script:LastState -or -not $Script:LastState.ok) {
    Refresh-State
    return
  }

  $command = $Script:LastState.workflow.nextAction.command
  switch ($command) {
    "open" { Invoke-OpenBrowser }
    "search" { Invoke-Search }
    "open-video" { Invoke-OpenVideo }
    "comments" { Invoke-Comments }
    "watch" { Invoke-Watch }
    default { Refresh-State }
  }
}

function Invoke-OpenBrowser {
  Invoke-Action "打开浏览器" @("browser", "open", "--once")
}

function Invoke-FindSearch {
  Invoke-Action "识别搜索框" @("douyin", "find-search") $false
}

function Invoke-Search {
  Invoke-Action "搜索关键词" @("douyin", "input-search", "--terms", (Get-Terms))
}

function Invoke-OpenVideo {
  Invoke-Action "打开视频" @("douyin", "open-video")
}

function Invoke-Comments {
  Invoke-Action "打开评论区" @("douyin", "open-comments")
}

function Invoke-Watch {
  Invoke-Action "刷评论并切视频" (@("douyin", "watch-cycle") + (Get-WatchArgs))
}

function Invoke-SearchCycle {
  Invoke-Action "刷一会后换搜索词" (@("douyin", "search-cycle") + (Get-SearchCycleArgs))
}

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = [System.Windows.Forms.Form]::new()
$form.Text = "抖音自动化可视化控制台"
$form.StartPosition = "CenterScreen"
$form.Size = [System.Drawing.Size]::new(1180, 780)
$form.MinimumSize = [System.Drawing.Size]::new(1040, 700)
$form.Font = [System.Drawing.Font]::new("Microsoft YaHei UI", 9)

$panelTop = [System.Windows.Forms.Panel]::new()
$panelTop.Dock = "Top"
$panelTop.Height = 118
$panelTop.Padding = [System.Windows.Forms.Padding]::new(12)
$form.Controls.Add($panelTop)

$lblTerms = [System.Windows.Forms.Label]::new()
$lblTerms.Text = "候选搜索词"
$lblTerms.Location = [System.Drawing.Point]::new(12, 14)
$lblTerms.Size = [System.Drawing.Size]::new(90, 24)
$panelTop.Controls.Add($lblTerms)

$txtTerms = [System.Windows.Forms.TextBox]::new()
$txtTerms.Text = "情感;日常vlog;恋爱技巧"
$txtTerms.Location = [System.Drawing.Point]::new(105, 12)
$txtTerms.Size = [System.Drawing.Size]::new(420, 24)
$panelTop.Controls.Add($txtTerms)

$chkQuick = [System.Windows.Forms.CheckBox]::new()
$chkQuick.Text = "测试模式 10-15 秒"
$chkQuick.Location = [System.Drawing.Point]::new(545, 12)
$chkQuick.Size = [System.Drawing.Size]::new(150, 24)
$panelTop.Controls.Add($chkQuick)

$labels = @(
  @("停留最小ms", 12, 48),
  @("停留最大ms", 178, 48),
  @("换词最小ms", 344, 48),
  @("换词最大ms", 510, 48),
  @("搜索次数", 676, 48),
  @("视频周期", 814, 48)
)
foreach ($entry in $labels) {
  $label = [System.Windows.Forms.Label]::new()
  $label.Text = $entry[0]
  $label.Location = [System.Drawing.Point]::new($entry[1], $entry[2])
  $label.Size = [System.Drawing.Size]::new(82, 24)
  $panelTop.Controls.Add($label)
}

$txtMinWatch = [System.Windows.Forms.TextBox]::new()
$txtMinWatch.Text = "120000"
$txtMinWatch.Location = [System.Drawing.Point]::new(95, 46)
$txtMinWatch.Size = [System.Drawing.Size]::new(72, 24)
$panelTop.Controls.Add($txtMinWatch)

$txtMaxWatch = [System.Windows.Forms.TextBox]::new()
$txtMaxWatch.Text = "180000"
$txtMaxWatch.Location = [System.Drawing.Point]::new(261, 46)
$txtMaxWatch.Size = [System.Drawing.Size]::new(72, 24)
$panelTop.Controls.Add($txtMaxWatch)

$txtMinBrowse = [System.Windows.Forms.TextBox]::new()
$txtMinBrowse.Text = "120000"
$txtMinBrowse.Location = [System.Drawing.Point]::new(427, 46)
$txtMinBrowse.Size = [System.Drawing.Size]::new(72, 24)
$panelTop.Controls.Add($txtMinBrowse)

$txtMaxBrowse = [System.Windows.Forms.TextBox]::new()
$txtMaxBrowse.Text = "180000"
$txtMaxBrowse.Location = [System.Drawing.Point]::new(593, 46)
$txtMaxBrowse.Size = [System.Drawing.Size]::new(72, 24)
$panelTop.Controls.Add($txtMaxBrowse)

$txtSearches = [System.Windows.Forms.TextBox]::new()
$txtSearches.Text = "2"
$txtSearches.Location = [System.Drawing.Point]::new(748, 46)
$txtSearches.Size = [System.Drawing.Size]::new(48, 24)
$panelTop.Controls.Add($txtSearches)

$txtCycles = [System.Windows.Forms.TextBox]::new()
$txtCycles.Text = "1"
$txtCycles.Location = [System.Drawing.Point]::new(886, 46)
$txtCycles.Size = [System.Drawing.Size]::new(48, 24)
$panelTop.Controls.Add($txtCycles)

$buttonDefs = @(
  @("打开浏览器", 12, 82, { Invoke-OpenBrowser }),
  @("刷新状态", 112, 82, { Refresh-State }),
  @("执行下一步", 212, 82, { Invoke-Next }),
  @("识别搜索框", 326, 82, { Invoke-FindSearch }),
  @("搜索", 440, 82, { Invoke-Search }),
  @("选视频", 518, 82, { Invoke-OpenVideo }),
  @("打开评论", 596, 82, { Invoke-Comments }),
  @("刷评论/切视频", 696, 82, { Invoke-Watch }),
  @("换词循环", 826, 82, { Invoke-SearchCycle })
)
foreach ($def in $buttonDefs) {
  $button = [System.Windows.Forms.Button]::new()
  $button.Text = $def[0]
  $button.Location = [System.Drawing.Point]::new($def[1], $def[2])
  $button.Size = [System.Drawing.Size]::new($(if ($def[0].Length -gt 5) { 118 } else { 88 }), 28)
  $handler = $def[3]
  $button.Add_Click($handler)
  $panelTop.Controls.Add($button)
  $Script:Buttons += $button
}

$split = [System.Windows.Forms.SplitContainer]::new()
$split.Dock = "Fill"
$split.Orientation = "Vertical"
$split.SplitterDistance = 500
$form.Controls.Add($split)

$panelStatus = [System.Windows.Forms.Panel]::new()
$panelStatus.Dock = "Fill"
$panelStatus.Padding = [System.Windows.Forms.Padding]::new(12)
$split.Panel1.Controls.Add($panelStatus)

$lblPage = [System.Windows.Forms.Label]::new()
$lblPage.Text = "页面：-"
$lblPage.Location = [System.Drawing.Point]::new(12, 12)
$lblPage.Size = [System.Drawing.Size]::new(470, 24)
$panelStatus.Controls.Add($lblPage)

$lblUrl = [System.Windows.Forms.Label]::new()
$lblUrl.Text = "地址：-"
$lblUrl.Location = [System.Drawing.Point]::new(12, 38)
$lblUrl.Size = [System.Drawing.Size]::new(470, 42)
$panelStatus.Controls.Add($lblUrl)

$lblCurrent = [System.Windows.Forms.Label]::new()
$lblCurrent.Text = "当前位置：-"
$lblCurrent.Location = [System.Drawing.Point]::new(12, 86)
$lblCurrent.Size = [System.Drawing.Size]::new(470, 24)
$panelStatus.Controls.Add($lblCurrent)

$lblNext = [System.Windows.Forms.Label]::new()
$lblNext.Text = "下一步：-"
$lblNext.Location = [System.Drawing.Point]::new(12, 112)
$lblNext.Size = [System.Drawing.Size]::new(470, 48)
$panelStatus.Controls.Add($lblNext)

$lblSearch = [System.Windows.Forms.Label]::new()
$lblSearch.Text = "搜索框：-"
$lblSearch.Location = [System.Drawing.Point]::new(12, 166)
$lblSearch.Size = [System.Drawing.Size]::new(150, 24)
$panelStatus.Controls.Add($lblSearch)

$lblVideo = [System.Windows.Forms.Label]::new()
$lblVideo.Text = "视频候选：-"
$lblVideo.Location = [System.Drawing.Point]::new(170, 166)
$lblVideo.Size = [System.Drawing.Size]::new(150, 24)
$panelStatus.Controls.Add($lblVideo)

$lblComment = [System.Windows.Forms.Label]::new()
$lblComment.Text = "评论区：-"
$lblComment.Location = [System.Drawing.Point]::new(328, 166)
$lblComment.Size = [System.Drawing.Size]::new(160, 24)
$panelStatus.Controls.Add($lblComment)

$listSteps = [System.Windows.Forms.ListView]::new()
$listSteps.Location = [System.Drawing.Point]::new(12, 198)
$listSteps.Size = [System.Drawing.Size]::new(470, 420)
$listSteps.View = "Details"
$listSteps.CheckBoxes = $true
$listSteps.FullRowSelect = $true
$listSteps.Columns.Add("步骤", 260) | Out-Null
$listSteps.Columns.Add("状态", 80) | Out-Null
$listSteps.Columns.Add("ID", 110) | Out-Null
$panelStatus.Controls.Add($listSteps)

$txtLog = [System.Windows.Forms.TextBox]::new()
$txtLog.Dock = "Fill"
$txtLog.Multiline = $true
$txtLog.ReadOnly = $true
$txtLog.ScrollBars = "Vertical"
$txtLog.BackColor = [System.Drawing.Color]::FromArgb(18, 22, 30)
$txtLog.ForeColor = [System.Drawing.Color]::FromArgb(226, 232, 240)
$txtLog.Font = [System.Drawing.Font]::new("Consolas", 9)
$split.Panel2.Controls.Add($txtLog)

$form.Add_Shown({ Refresh-State })
[System.Windows.Forms.Application]::Run($form)



