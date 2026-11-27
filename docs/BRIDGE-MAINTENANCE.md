# LeChonk bridge maintenance

This procedure requires a gateway and running LeChonk bridge that support the
maintenance handshake. The authenticated `GET /api/status` shows
`maintenanceSupported: true` on the LeChonk row when that bridge advertises it.
The initial rollout of these versions needs the existing deployment procedure.
**Sending SIGUSR2 to an older bridge can terminate it.**

1. From the bridge host, confirm the service owns the expected PID. Send
   `systemctl --user kill --kill-whom=main --signal=SIGUSR2 agent-desk-bridge.service`.
2. Check the authenticated status and the managed service journal. The gateway
   waits until voice, chat, audio finalization, detached research and known
   Claude turns are idle. New sessions can still start while it waits. When
   idle for one second, it briefly refuses new voice sessions and chat turns
   with HTTP 503 and fences new LeChonk RPCs. Methods with a supported
   alternative can use their existing route to Sandy. Audit events continue
   to go to gateway stdout. Their LeChonk copies may be absent while fenced.
3. Wait for `bridgeMaintenance: "ready"` and the current PID's fresh
   `maintenance ready for managed restart` record. The bridge waits for actual
   request operations, including ones whose caller already timed out, plus
   running Claude turns, login delivery, notes sync and audio retention work.
   The ready window lasts 60 seconds. Restart the managed service while the
   window is still open. A reconnect invalidates the old process's approval.
4. Verify the new managed PID, a changed LeChonk `instance` in the authenticated
   status, a healthy gateway with both bridges connected and a null
   `bridgeMaintenance`. The gateway reopens admission on the new bridge's hello. For an index change, perform an authenticated Discover or
   Map Search, then check the managed process's open index generations.

Before the ready phase the request expires after two minutes. A second SIGUSR2
cancels a connected bridge's request. If the bridge fails to return, the ready
window expires and normal routing resumes for the available host. If ready
cannot be confirmed, keep the current process serving and retry.
