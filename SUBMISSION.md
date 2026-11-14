# E394 – Nevada · Smooth Journey

**Team:** Chris, Ruthvik, Ingram, Abi

## Links

- **Live app (AWS):** https://REPLACE-WITH-YOUR-CLOUDFRONT-DOMAIN
- **Three-phone demo:** https://REPLACE-WITH-YOUR-CLOUDFRONT-DOMAIN/demo.html
- **Codebase:** https://github.com/REPLACE-WITH-YOUR-USERNAME/smooth-journey

## Demo accounts

Password for all: `SmoothDemo2026`. They're also one-tap buttons on the welcome screen.

| Role | Email |
|---|---|
| Passenger (Mrs Chan) | mrs.chan@example.com |
| Carer (Mei) | mei@example.com |
| Ground staff | staff@example.com |
| Cabin crew | crew@example.com |
| Supervisor | supervisor@example.com |

You can also create your own passenger or carer account with any email address.

## Try it in 3 minutes (best with three phones)

1. **Phone 1 – Passenger (Mrs Chan):** Trip → **Start travel day**. Press "I'm here. Where's my help?"
2. **Phone 2 – Staff:** My post shows Mrs Chan and her help request. Tap **On my way**, then **confirm handover**. Switch post to Security, then Gate, and confirm each.
3. **Phone 3 – Carer (Mei):** watch each step arrive by itself.
4. **Crew:** see Mrs Chan's approved brief; she presses "I need help (discreet)"; acknowledge, then hand over to the arrival team.
5. **Supervisor:** simulate a CX 255 delay and approve the re-plan; see real HKIA departure data. **Reset the demo trip** to start again.
6. **New passenger:** sign up, describe needs in plain words, see personal details removed, let AI suggest codes, and have staff confirm them under Checks.

## Technology

- AWS: CloudFront, private S3, Cognito (sign-up, verification, role groups), API Gateway HTTP API with JWT authorisation, Lambda (Node.js 22), DynamoDB. All deployed as code with AWS SAM.
- AI: Amazon Nova Lite on Amazon Bedrock for needs-to-IATA-code mapping, crew brief drafting and a policy-grounded concierge. Every AI output is checked by a person or by fixed rules.
- Open data: Hong Kong International Airport flight information (DATA.GOV.HK), fetched live.
- Privacy by design: explicit consent, redaction before AI (browser and server), needs not diagnoses, need-to-know enforced on the server, passenger sharing switches, access log, export, delete account, 30-day expiry, no content logging.
- Installable on phones (Add to Home Screen). Tested with unit tests and a five-role end-to-end browser test.

*Student concept prototype. Not a Cathay Pacific product. Flights, bookings and policy text are fictional.*
