# SupportMe documentation

This page indexes the project documentation, grouped by audience. To add a new
document under `docs/`, add a link to it here.

## Getting started

- [Project README](../README.md): what SupportMe is, the deployed testnet
  contracts, and local setup for the backend and frontend.
- [Contributing guide](../CONTRIBUTING.md): workflow, repository layout and
  development setup.
- [Adding translations](i18n.md): how to add interface strings and languages.
- [Testing](../TESTING.md): what CI runs and how to run each test suite
  locally.
- [Testnet troubleshooting](testnet-troubleshooting.md): every wallet,
  donation, subscription and cash-out error title, with testnet causes and
  fixes, plus an FAQ.
- [Testnet demo walkthrough](testnet-demo-walkthrough.md): a scripted,
  step-by-step run through onboarding, one-off and recurring donations,
  goals and receipts on testnet, with a video shot list for re-recording the
  demo.
- [Architecture overview](architecture.md): components, data flow and how the
  frontend, backend and contracts fit together.

## Backend & API

- [Backend README](../backend/README.md): backend quick start, endpoints and
  how to create a schema change (Prisma migrations).
- [Backend configuration](../backend/docs/CONFIGURATION.md): every backend
  environment variable, with defaults and local, staging and production
  guidance.
- [Backend API reference](backend-api-reference.md): request and response
  documentation for every endpoint.
- [Authentication](authentication.md): wallet sign-in, Twitter/X OAuth and
  email magic links, including provider setup.

## Contracts

- [Contract events specification](architecture/contract-events.md): the
  Soroban events that the donation and registry contracts emit, and how the
  backend indexes them.
- [Contract deploy and promotion workflow](contract-deploy-workflow.md):
  building, deploying and promoting contracts across environments.
- [Contract upgrade and migration strategy](contract-upgrade-migration.md):
  upgrade runbook and data migration approach.
- [Multi-signature and timelock administration](admin-multisig-timelock.md):
  contract governance, the emergency pause, and admin proposals.

## Operations

- [Production runbook](production-runbook.md): incident response for RPC
  outages, database problems, failed recurring charges, bad deploys and
  executor key issues.
- [Production database backups](database-backups.md): the Railway
  PostgreSQL backup policy and how to verify backups.
- [Local anchor platform](../anchor/README.md): running the self-hosted
  SEP-24 test anchor for the cash-out flow.

## Design

- [Donation and subscription failure states](design/donation-subscription-failure-states.md)
- [Embeddable donation widget](design/donation-widget.md)
- [Empty states](design/empty-states.md)
- [Onboarding flow for new creators](design/onboarding-flow.md)
- [Custom profile themes](design/profile-themes.md)
- [WCAG 2.1 AA accessibility audit](accessibility-audit.md)

## Security

- [Contract security review (September 2026)](security/contract-security-review-2026-09.md)
- [Authentication](authentication.md): the security model for each sign-in
  method. This document is also listed under Backend & API.
