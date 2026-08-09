$ErrorActionPreference = 'Stop'

$project = 'gatherly-phase6-redis-outage'
$compose = @('-p', $project, '-f', 'compose.yaml')
$appPort = if ([string]::IsNullOrWhiteSpace($env:APP_PORT)) { '3000' } else { $env:APP_PORT }
$baseUrl = "http://127.0.0.1:$appPort"

function Assert-LastExitCode([string]$message) {
  if ($LASTEXITCODE -ne 0) { throw $message }
}

function Get-HttpStatus([string]$uri) {
  try {
    return (Invoke-WebRequest -Uri $uri).StatusCode
  }
  catch {
    if ($null -ne $_.Exception.Response) {
      return [int]$_.Exception.Response.StatusCode
    }
    return 0
  }
}

try {
  docker compose @compose up --detach --build
  Assert-LastExitCode 'Compose startup failed'

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Seconds 1
    if ((Get-HttpStatus "$baseUrl/health/ready") -eq 200) {
      $ready = $true
      break
    }
  }
  if (-not $ready) { throw 'Application did not become ready within 30 seconds' }

  $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $passwordBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
  $password = [Convert]::ToBase64String($passwordBytes)
  $credentials = @{
    username = "redis_drill_$suffix"
    password = $password
  } | ConvertTo-Json

  $signUp = Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/sign-up" `
    -ContentType 'application/json' -Body $credentials
  $headers = @{ Authorization = "Bearer $($signUp.data.accessToken)" }

  $communityBody = @{
    name = "Redis Drill $suffix"
    slug = "redis-drill-$suffix"
  } | ConvertTo-Json
  $community = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/communities" `
    -Headers $headers -ContentType 'application/json' -Body $communityBody

  $eventBody = @{
    title = 'Redis outage event'
    slug = 'redis-outage-event'
    startsAt = '2030-08-03T18:00:00.000Z'
    endsAt = '2030-08-03T21:00:00.000Z'
    timezone = 'Europe/Moscow'
    capacity = 10
  } | ConvertTo-Json
  $event = Invoke-RestMethod -Method Post `
    -Uri "$baseUrl/api/communities/$($community.data.id)/events" `
    -Headers $headers -ContentType 'application/json' -Body $eventBody

  $eventUri = "$baseUrl/api/events/$($event.data.id)"
  $warm = Invoke-RestMethod -Method Get -Uri $eventUri
  if ($warm.data.id -ne $event.data.id) { throw 'Could not warm the event cache' }

  docker compose @compose exec -T redis redis-cli EXISTS "gatherly:v1:event:$($event.data.id)"
  Assert-LastExitCode 'Could not inspect the event cache key'

  docker compose @compose stop redis
  Assert-LastExitCode 'Could not stop Redis'

  if ((Get-HttpStatus "$baseUrl/health/live") -ne 200) { throw 'Liveness failed' }
  if ((Get-HttpStatus "$baseUrl/health/ready") -ne 200) {
    throw 'Readiness must remain 200 during an optional Redis outage'
  }

  $duringOutage = Invoke-RestMethod -Method Get -Uri $eventUri
  if ($duringOutage.data.id -ne $event.data.id) {
    throw 'PostgreSQL event read failed during Redis outage'
  }

  $reservation = Invoke-WebRequest -Method Post `
    -Uri "$baseUrl/api/events/$($event.data.id)/reservations" `
    -Headers ($headers + @{ 'Idempotency-Key' = "redis-outage-$suffix" }) `
    -ContentType 'application/json' -Body '{}'
  if ($reservation.StatusCode -notin @(200, 201)) {
    throw "Reservation returned $($reservation.StatusCode) during Redis outage"
  }

  docker compose @compose start redis
  Assert-LastExitCode 'Could not restart Redis'

  $redisHealthy = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Seconds 1
    docker compose @compose exec -T redis redis-cli PING | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $redisHealthy = $true
      break
    }
  }
  if (-not $redisHealthy) { throw 'Redis did not recover within 30 seconds' }

  Start-Sleep -Seconds 2
  $afterRecovery = Invoke-RestMethod -Method Get -Uri $eventUri
  if ($afterRecovery.data.id -ne $event.data.id) { throw 'Event read failed after recovery' }

  docker compose @compose logs app
  Write-Host 'Phase 6 Redis outage drill passed'
}
finally {
  # Safe because this project name belongs only to this disposable drill.
  docker compose @compose down --volumes
}
