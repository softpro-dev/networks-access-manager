
Open PowerShell as Administrator mode

```bash

# 1. Check status:: Status should be "Running"
Get-Service OrganizationNetworkAgent      


# 2. What does the service think? (best single check
& "C:\Program Files\SoftProIt Network\conducted\SoftProIt.network.conducted.exe" status

# 3.  Watch the log live
Get-Content "C:\ProgramData\OrganizationNetworkAgent\logs\agent.log" -Wait -Tail 50


# 4. Restart-Service 
Restart-Service OrganizationNetworkAgent

# 5. Clear Old Logs
Clear-Content "C:\ProgramData\OrganizationNetworkAgent\logs\agent.log"
Remove-Item "C:\ProgramData\OrganizationNetworkAgent\logs\agent.log.*" -Force
