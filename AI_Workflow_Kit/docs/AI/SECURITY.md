# Security Engineer policy

## Principle

A full Security pass is **expensive** (top models, deep reading, long reports).  
It is **not** part of normal coding steps. Feature QA stays with **Tester**.

**When:** almost only **once**, near the **end of the project** — after implementation, review, and testing are essentially done, and release is in sight.  
**How:** Orchestrator **offers** it to Human — it is a **proposal**, not a mandatory step.  
**Who:** a separate Security agent with a **maximum-quality** model. Security finds and describes; **Coder** fixes product code.

---

## Roles

| Role | Frequency | Owns |
|------|-----------|------|
| **Tester** | Every step (if enabled) | Feature coverage, tests, functional bugs |
| **Security Engineer** | **Once near release** (or Human asks earlier) | Deep vuln hunt, `SECURITY_REPORT.md`, optional sec guards |
| **Orchestrator** | Always | **Offers** Security at end; never forces; routes SEC-* to Coder |
| **Coder** | On fix | Only role that patches product for SEC-* |
| **Reviewer** | Per step | May note smells; does not own security campaign |

---

## When to offer Security (Orchestrator)

### Primary moment — end of train / pre-release

When steps are largely green and ship is near, Orchestrator **must offer** (not command):

> We are close to release. Feature work and tests look complete enough.  
> **Optional next step:** a one-time deep **Security** audit for vulnerabilities.  
> This is **not required**, but recommended before shipping.  
> It is **expensive**: use a top-tier model (see below). We usually run this **once** per project when the product is ready.  
> Do you want to run it?

### Other triggers (still optional)

| Trigger | Notes |
|---------|--------|
| Human asks | Anytime — still warn about cost |
| Large new attack surface late | e.g. new auth, downloads, IPC — prefer still after that surface is feature-tested |
| STATE `security.next_run: pending` | Only if Human already agreed |

**Do not:**

- Attach full Security to every Tester kick  
- Use mid-tier coding models (e.g. Terra) as the Security default  
- Run Security mid-train “just because” when the product is still unstable  

Cheap hygiene in the normal gate (e.g. no-secrets check) is **not** a Security campaign.

---

## Recommended models (Security only)

These must be **max quality**. Cheap flash models are the wrong tool for a final vuln hunt.

| Priority | Model | Reasoning | Notes |
|----------|-------|-----------|-------|
| **Primary** | **GLM 5.2** | **Maximum** | Strong default for vulnerability hunting |
| Strong alt | **GPT 5.6 Sol** | **Maximum** | Excellent; **expensive** |
| Strong alt | **Opus 5** (or current top Opus) | **Maximum** | Also capable; **expensive** |

**Always warn Human before the kick:**

- Procedure is **costly** (tokens / limits / time).  
- Models should be the **most capable** available, not Luna/Terra flash.  
- Typically **one deep pass** when the project is ready — not every week.

---

## Security Reviewer duties (when dispatched)

1. Deep, systematic read-only review of the assigned attack surface.
2. Research known issue classes for the stack when needed.
3. Trace data flow and trust boundaries with Graphify, then verify real source.
4. Return structured findings with severity, evidence, suspect files, and fix direction.
5. Hand off only to Main. Main verifies and writes `SECURITY_REPORT.md`; Coder
   applies product fixes and regression guards.

Typical areas: auth, secrets, network, downloads/integrity, path traversal, workers/IPC, injection, sensitive I/O, privacy entitlements.

---

## Severity → workflow (after Security handoff)

| Severity | Orchestrator |
|----------|----------------|
| **critical / high** | Coder fix before ship; Reviewer → Tester; optional Security re-pass if Human wants |
| **medium** | Coder fix or Human accepts residual risk |
| **low / info** | Note / backlog |

---

## Forbidden

- Full Security every coding step  
- Defaulting Security to mid coding models (Terra, Luna flash, etc.)  
- Security or Tester editing product source to “fix” findings  
- Live secrets in reports  
- Weaponized exploit PoCs beyond a minimal local assert  

---

## Assets

- Policy: this file  
- Kick: `KICK_SECURITY.md`  
- Report: `SECURITY_REPORT.md`  
- Models: `MODELS.md` (Security row)
