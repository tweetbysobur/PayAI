# PayAI Smart Contract Protocol Behavior & Security Properties Map

This document formally defines the security properties, invariants, state boundaries, and role models for the PayAI smart contract suite (`PaymentExecutor`, `AutomationVault`, `MerchantRegistry`, `VeriPayRegistry`).

Automated analysis agents, fuzzing harnesses (Echidna, Foundry, Medusa), and static analysis tools (Slither, Mythril) can use these explicitly specified properties to test boundary conditions and map protocol invariants.

---

## 1. Protocol Architecture & Key Contracts

```mermaid
graph TD
    User([User Wallet]) -->|reserve()| Vault[AutomationVault]
    User -->|approve()| Executor[PaymentExecutor]
    Agent([AI Hot Wallet Agent]) -->|release()| Vault
    Agent -->|executePayment / executePaymentFrom| Executor
    Executor -->|recordVolume()| MerchantReg[MerchantRegistry]
    Agent -->|recordPayment()| AuditReg[VeriPayRegistry]
    Owner([Cold Wallet Owner]) -->|Admin / Limits / Pausing| Executor & Vault & MerchantReg
```

---

## 2. Invariant Specifications

### A. AutomationVault (`AutomationVault.sol`)

| ID | Invariant Property Name | Formal Rule | Behavioral Guard |
| :--- | :--- | :--- | :--- |
| **INVARIANT-AV-1** | Reserve Balance Solvency | $\text{balanceOf}(\text{token}) \ge \text{totalReservedByToken}[\text{token}] \left(= \sum \text{reservations}[\text{automationId}].\text{balance for that token}\right)$ | The vault must never hold fewer funds than the sum of active isolated reservations. Actively enforced (not just implied by other checks): `totalReservedByToken[token]` is maintained on every `reserve()`/`release()`/`refund()` and asserted against real `balanceOf`/`address(this).balance` at the end of each call, so one reservation's release, refund, or surcharge can never silently leave another reservation of the same token under-backed. |
| **INVARIANT-AV-2** | Directional Fund Lock | $\text{release}() \to r.\text{recipient}$; $\text{refund}() \to r.\text{depositor}$ | Released funds can **ONLY** be transferred to $r.\text{recipient}$. Refunded funds can **ONLY** be transferred to $r.\text{depositor}$. Neither caller nor agent can alter the destination. |
| **INVARIANT-AV-3** | Release Idempotency | $\forall \text{requestId}, \text{usedRequestId}[\text{requestId}] = \text{true} \implies \text{execution count} \le 1$ | Duplicate `requestId` submissions for `release()` MUST revert. |
| **INVARIANT-AV-4** | Immutable Reservation Terms | $\text{depositor}_2 = \text{depositor}_1 \land \text{token}_2 = \text{token}_1 \land \text{recipient}_2 = \text{recipient}_1$ | Topping up an existing `automationId` enforces parameter equality with the original reservation. |
| **INVARIANT-AV-5** | Checks-Effects-Interactions & Reentrancy | Balance state updated **BEFORE** external transfer call | Balance is debited/zeroed before triggering ERC-20 transfer or native MON call, backed by a reentrancy lock. |
| **INVARIANT-AV-6** | Role Isolation | $\text{owner} \ne \text{agent} \land \text{isAgent}[\text{owner}] = \text{false}$ | Owner cannot trigger fund release/refund. Agent cannot alter contract administration. |
| **INVARIANT-AV-7** | Actual Delivery, Not Requested Amount | $\Delta\text{balanceOf}(\text{party}) = \text{amount}$ for `reserve()`/`release()`/`refund()`, verified via before/after `balanceOf`, not a truthy return value | A non-standard (fee-on-transfer) ERC-20 delivering less than `amount` MUST revert the whole operation. Added 2026-07 after Ultrafuzz M-02: `reserve()` previously credited `r.balance` with the requested amount regardless of actual receipt, and `release()`/`refund()` trusted the same figure on the way out. |
| **INVARIANT-AV-8** | Outbound Debit Matches Ledger | $\Delta\text{balanceOf}(\text{vault}) = \text{amount}$ for `release()`/`refund()`, verified via before/after `balanceOf` on the vault itself, not just the counterparty | A non-standard ERC-20 that surcharges the SENDER (the vault) on an outgoing `transfer()` — delivering the recipient's side in full, but debiting the vault for more than `amount` — MUST revert the whole operation. Added 2026-08 after Ultrafuzz M-01: INVARIANT-AV-7 alone verified the counterparty received `amount`, but never verified the vault's own balance fell by exactly `amount`, so a sender-surcharge token could quietly consume the pooled custody backing OTHER depositors' active reservations. |
| **INVARIANT-AV-ACCOUNTING** | Deposit-Payout Conservation | $\text{Deposits} \equiv \text{Payouts} + \text{Refunds} + \text{Active Reserves}$ | Across millions of randomized deposit/release/refund sequences, contract balance strictly matches remaining active reserves with zero leakage or fee drift. |

---

### B. PaymentExecutor (`PaymentExecutor.sol`)

| ID | Invariant Property Name | Formal Rule | Behavioral Guard |
| :--- | :--- | :--- | :--- |
| **INVARIANT-PE-1** | Settlement Idempotency | $\forall \text{requestId}, \text{usedRequestId}[\text{requestId}] = \text{true} \implies \text{execCount} \le 1$ | Every settlement claims `requestId`. Duplicate resubmissions MUST revert. |
| **INVARIANT-PE-2** | Single-Tx Ceiling | $\text{amount} \le \min(\text{merchantMaxTx}[\text{merchant}], \text{maxTxAmount})$ | No single transaction can exceed configured single-tx bounds. |
| **INVARIANT-PE-3** | Per-Agent Daily Cap Ceiling | $\text{spentPerDay}[\text{agent}][\text{day}] + \text{amount} \le \text{dailyCap}$ | Cumulative agent spend in a 24h UTC window cannot exceed the owner-configured daily cap. |
| **INVARIANT-PE-4** | Pull-Payment Merchant Gate | $\text{executePaymentFrom}() \implies \text{isRegistered}(\text{merchant}) \land \text{isActive}(\text{merchant})$ | Pulling funds from an approving user requires the destination merchant to be registered & active in `MerchantRegistry`. |
| **INVARIANT-PE-5** | Risk Score Bound | $0 \le \text{riskScore} \le 100$ | Risk score inputs $> 100$ MUST revert immediately, on EVERY entrypoint that persists a risk score — including `recordRejection`, which was missing this check until Ultrafuzz L-01 (2026-07) found the settlement functions enforced it but the rejection-recording path did not. |
| **INVARIANT-PE-6** | Strict Role Separation | $\text{owner} \ne \text{agent} \land \text{isAgent}[\text{owner}] = \text{false}$ | Owner cannot sign or trigger payment execution; Agent cannot modify spend limits or pause states. |
| **INVARIANT-PE-8** | Actual Delivery, Not Requested Amount | $\Delta\text{balanceOf}(\text{merchant}) = \text{amount}$, verified via before/after `balanceOf`, not a truthy `transferFrom` return value | A non-standard ERC-20 delivering less than `amount` MUST revert `executePayment`/`executePaymentFrom` entirely, never be recorded/accrued as a full settlement. Added 2026-07 after Ultrafuzz M-02. |
| **INVARIANT-CONCURRENCY** | Double-Spend Mutex Guard | Synchronous / Concurrent `requestId` reuse reverts | Rapid, concurrent or interrupted executions cannot double-spend or lock contract state in intermediate balances. |
| **INVARIANT-MATH-BOUNDS** | Arithmetic Overflow / Underflow Safety | Solidity 0.8.24 native checked arithmetic | Amount = 0, riskScore > 100, or zero address calls revert with clean explicit errors. |

---

### C. MerchantRegistry (`MerchantRegistry.sol`)

| ID | Invariant Property Name | Formal Rule | Behavioral Guard |
| :--- | :--- | :--- | :--- |
| **INVARIANT-MR-1** | Manager Authorization | $\text{msg.sender} \in \text{Managers}$ for `registerMerchant` and `setActive` | Only authorized managers can alter merchant state in the registry. |
| **INVARIANT-MR-2** | Recorder Volume Accrual | $\text{msg.sender} \in \text{Recorders}$ for `recordVolume` | Only authorized recorder contracts (e.g. `PaymentExecutor`) can accrue merchant volume. |
| **INVARIANT-MR-3** | Unique Registration | $\text{registeredAt}(\text{wallet}) \ne 0 \implies \text{revert on second registration}$ | A wallet address can only be registered once. |

---

### D. VeriPayRegistry (`VeriPayRegistry.sol`)

| ID | Invariant Property Name | Formal Rule | Behavioral Guard |
| :--- | :--- | :--- | :--- |
| **INVARIANT-VR-1** | Agent-Only Audit Logging | $\text{isAgent}[\text{msg.sender}] = \text{true}$ for `recordPayment` / `payAndRecord` | Only authorized agents can record audit entries on-chain. |
| **INVARIANT-VR-2** | Audit Risk Score Cap | $0 \le \text{riskScore} \le 100$ | Invalid risk scores $> 100$ revert. |

---

## 3. Automated Fuzzing & Property Verification Directions

To test these properties using fuzzing frameworks (e.g. Echidna / Foundry invariant testing):

1. **State Sequences**: Execute random sequences of `reserve()`, `release()`, and `refund()` in `AutomationVault` with arbitrary amounts and check after every step that `token.balanceOf(vault) >= total_active_reservations`.
2. **Reentrancy Invariant**: Deploy a malicious receiver contract attempting re-entrant calls to `release()` or `refund()` during native MON call callbacks; verify that all re-entrant attempts revert with `"reentrant"`.
3. **Limit Boundary Invariant**: Generate pseudo-random arrays of payment amounts against `PaymentExecutor` under tight daily cap settings; verify that no combination of transactions allows `spentPerDay` to exceed `dailyCap`.
4. **Idempotency Invariant**: Generate repeated random requests with identical `requestId` hashes; verify that exactly one succeeds and all subsequent calls revert with `"duplicate requestId"`.
