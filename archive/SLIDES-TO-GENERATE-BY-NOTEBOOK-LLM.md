# Slides for NotebookLM

Style: Apple minimalistic. White background, dark text, one accent color (blue), no shadows/gradients, rounded boxes, generous whitespace.

---

## Slide 1: The Enterprise AI Dilemma

A large rounded box labeled "Enterprise Codebase". Inside it, four items in a grid: Business Logic, Internal Naming, Secrets & Credentials, Architecture Patterns. Label the box "Proprietary Code". Below it: "Cannot expose to external tools without controls" in muted red.

---

## Slide 2: The Cloaked Workspace Flow

Vertical flow, five steps connected by arrows top to bottom:

1. Original Repository (inside "Enterprise Boundary" border)
2. Secret Detection (20+ categories)
3. Anonymization (Case-preserving)
4. Cloaked Workspace (Safe for AI tools)
5. Reverse Mapping (Decrypt + Merge)
   Arrow from step 5 loops back to step 1: "Changes restored".

---

## Slide 3: Git-Aware File Selection

One box at top: "Git Repository Detected". Three boxes below side by side: "Uncommitted Changes", "Specific Commits", "Manual Selection". All three connect to one box at bottom: "Selected Files".

---

## Slide 4: Anonymization

Two columns. Left: "Original" showing xcorp-platform/ with XCorpServices/, XCorpPaymentService.cs, xcorp-settings.json. Right: "Cloaked" showing acme-platform/ with AcmeServices/, AcmePaymentService.cs, acme-settings.json. Arrow between columns. Monospaced file names.

---

## Slide 5: Secret Scanner

Flow: "Selected Files" → "Secret Scanner (20+ patterns)" → five categories in a row (Cloud Keys, Platform Tokens, Payment Keys, Crypto Material, Infrastructure). Below: two outcomes side by side. Left: "HALT - Show file + line, require confirmation" (red). Right: "CLEAN - Proceed" (green).

---

## Slide 6: What Gets Selected vs. Skipped

Two-column list. Left (green checkmarks): IPaymentService.cs, IPaymentValidator.cs, PaymentRequest.cs, PaymentResponse.cs, PaymentForm.tsx, PaymentForm.test.tsx. Right (red crosses): PaymentService.cs (proprietary), PaymentGatewayAdapter.cs (proprietary), appsettings.json (credentials).

---

## Slide 7: Where Repo-Cloak Fits

Two stacked boxes. Top (gray): "Existing Controls" with Access Controls, Security Policies, Contracts. Bottom (blue tint): "Repo-Cloak Layer" with Scoped Exposure, Secret Detection, Encrypted Mappings, Audit Trail, Local Processing. Label between: "works alongside". Below both: "Controlled AI Adoption with Audit Trail".
