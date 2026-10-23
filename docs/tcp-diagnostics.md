# Windows localhost TCP 진단

10013 하나로 샌드박스·방화벽·포트 예약을 구분할 수 없습니다.
Microsoft는 10013을 접근 거부로 정의하며 배타적으로 점유된 주소도 10013 또는 10048을 유발할 수 있다고 설명합니다.
[Winsock 오류](https://learn.microsoft.com/en-us/windows/win32/winsock/windows-sockets-error-codes-2),
[배타적 주소 사용](https://learn.microsoft.com/en-us/windows/win32/winsock/so-exclusiveaddruse)를 참고합니다.

## 1. 동일 Python으로 실행 환경 비교

Codex 밖의 일반 PowerShell에서 실행합니다.

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
.\.venv\Scripts\python.exe -c "import sys; print(sys.executable); print(sys._base_executable)"
.\.venv\Scripts\python.exe .\scripts\diagnose_tcp.py
$LASTEXITCODE
```

| 관측 | 해석 및 다음 확인 |
|---|---|
| 일반 PowerShell 성공, Codex만 실패 | 실행 토큰/샌드박스 또는 문맥별 보안 정책 차이가 유력합니다. 동일 Python인지 먼저 비교합니다. |
| 임시 포트 bind 성공, connect 10013 | 고정 포트 충돌만으로 설명하기 어렵습니다. 실행 권한과 방화벽/WFP/보안 제품을 확인합니다. |
| 임시 포트 왕복 성공, 특정 포트 bind 실패 | 해당 포트 점유와 제외 범위를 확인합니다. |
| bind 10048 | 사용 중이거나 배타적으로 점유된 주소일 수 있습니다. 리스닝 PID를 확인합니다. |
| bind 10013 | 정책 차단·제외 포트·배타적 주소 사용 등이 후보입니다. 코드만으로 확정하지 않습니다. |
| connect 10061 | 대상 노드의 리스닝/시작 실패 여부를 확인합니다. |

현재 Codex에서 임시 포트 bind와 9101~9106 bind는 성공했고 connect에서 10013이 관측되었습니다.
관리 정책 로그를 확보하지 못했으므로 구체적인 차단 원인은 확정하지 않았습니다.

## 2. 포트 충돌 확인

```powershell
Get-NetTCPConnection -LocalPort 9101,9102,9103,9104,9105,9106 -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort,State,OwningProcess
netstat -ano -p tcp | Select-String ':910[1-6]\s'
# 실제로 확인한 PID로 바꿔 조회
Get-Process -Id 12345
```

실행 중인 EXIT-LINK의 LISTENING은 정상입니다. TIME_WAIT와 LISTENING은 구별합니다.
임의의 다른 프로세스를 종료하지 않습니다. 통합 테스트는 고정 포트 대신 임시 포트를 사용합니다.

## 3. 제외/예약 포트 확인

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
netsh interface ipv4 show dynamicport tcp
```

실패한 실제 포트가 제외 범위에 포함되는지 비교합니다. 동적 포트 범위 자체가 예약 범위는 아닙니다.
일부 환경에서는 조회에 관리자 권한이 필요할 수 있습니다. 예약 범위를 삭제할 필요는 없습니다.
다른 포트를 시험하려면 원본 대신 로컬 복사본을 사용합니다.

```powershell
New-Item -ItemType Directory -Force .\data\measured\local-config | Out-Null
Copy-Item .\src\exit_link\data\simulation\communication.json .\data\measured\local-config\communication.json
# 복사본 nodes[].port만 중복 없는 사용 가능한 포트로 변경
.\.venv\Scripts\python.exe -m exit_link.communication node --id N1 --topology .\data\measured\local-config\communication.json
```

모든 node/send/stop 명령이 같은 `--topology` 파일을 사용해야 합니다.
[Microsoft netsh 문서](https://learn.microsoft.com/windows-server/networking/technologies/netsh/netsh-interface-portproxy),
[제외 포트의 10013 사례](https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/error-10013-wsaeacces-is-returned)를 참고합니다.
후자는 특정 Windows Server 상황에 대한 사례이므로 현재 PC의 원인을 확정하는 근거는 아닙니다.

## 4. 방화벽/보안 정책 조회

다음은 조회만 수행합니다. 필요한 경우 관리자 PowerShell에서 조회합니다.

```powershell
Get-NetFirewallProfile |
    Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction,LogBlocked,LogFileName
$exitLinkPython = (Resolve-Path .\.venv\Scripts\python.exe).Path
Get-NetFirewallApplicationFilter -Program $exitLinkPython -ErrorAction SilentlyContinue |
    Get-NetFirewallRule |
    Select-Object DisplayName,Enabled,Direction,Action,Profile
# 필터링 차단 감사가 이미 활성화된 시스템의 최근 이벤트
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=5157,5152; StartTime=(Get-Date).AddMinutes(-10)} -MaxEvents 20 |
    Select-Object TimeCreated,Id,Message
```

가상환경 Python과 1번에 표시된 실제 기반 Python 경로에 적용되는 규칙을 각각 확인합니다.
규칙/감사 이벤트가 보이지 않는다고 보안 정책이 없다고 단정하지 않습니다.
조직 정책·보안 제품·Windows Filtering Platform 정책도 확인 대상입니다.
이 절차에는 방화벽 비활성화나 광범위한 인바운드 허용이 없습니다.

## 5. 진단 후 실제 테스트

```powershell
.\.venv\Scripts\python.exe .\scripts\verify_stage2.py
$LASTEXITCODE
```

실제 summary.json, pytest-results.txt, 노드 로그를 확인한 후 통과 여부를 판단합니다.
사전 검사 실패는 TCP 통합 테스트 성공이나 전체 pytest 성공이 아닙니다.
