# TORI Browser Companion — Gate 24.1 Extension v1.0.4 Publication Report

**Project:** `F:\TORI\final tori download manager`  
**Extension Version:** `1.0.4` (Production Redesign Release)  
**Desktop Version:** `1.0.3` (Unchanged — Latest Stable)  
**Dedicated GitHub Release Tag:** `extension-v1.0.4`  
**Target Commit:** `cb87c9d` (Branch: `extension/v1.0.4`)  
**Official Website:** `https://toridownload.xyz`  
**Website Deployment Commit:** `6652b64` (`tori-website-private`)  
**Date:** 2026-11-12  
**Status:** `PUBLISHED & LIVE VERIFIED — 100% SUCCESS`

---

## Executive Summary

Gate 24.1 has successfully published and live-verified the new **TORI Browser Companion v1.0.4** across Chromium and Mozilla Firefox platforms, introducing the verified toolbar popup (Design 1) and floating video download overlay (Design 2) presentation layers.

In accordance with strict operational boundaries:
- **Desktop v1.0.3 Preserved:** The official Windows desktop release remains `v1.0.3 Latest Stable`. No desktop v1.0.4 binary, tag, or updater payload was created.
- **Auto-Updater Safe:** The official public auto-updater manifest at `https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json` remains untouched, strictly targeting Desktop v1.0.3.
- **Dedicated GitHub Release:** Published under dedicated release tag `extension-v1.0.4` with `make_latest: false`.
- **Mozilla AMO Signed XPI:** The officially signed Firefox add-on was verified, tested with signature enforcement in a real Firefox browser, and deployed to `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.4.xpi` with native `application/x-xpinstall` MIME headers.

---

## 1. Verified Asset Inventory & SHA-256 Checksums

| Asset File | Package Type | Size | SHA-256 Checksum | Signature Status |
|---|---|---|---|:---:|
| `tori-download-manager-firefox-v1.0.4.xpi` | Mozilla Add-on | 87,139 B | `f7f8f6044b4daf56b1519825798ad8884bc4500585b921b5803b5ee295692b59` | **Official Mozilla Signed (AMO)** |
| `tori-download-manager-extension-v1.0.4.zip` | Chromium / Edge MV3 | 72,995 B | `8bb803a3c3e68427b984980dd6c7633162a75d2f48c360ac6cfca95e3ac7c626` | **Verified MV3 Package** |
| `tori-download-manager-firefox-v1.0.4.zip` | AMO Source Archive | 72,720 B | `9575da0d8eb2ef16ab123dd43e7216c09f521cb23cc347af192659a58b63eced` | **AMO Forward-Slash Compliant** |
| `a70ed17e183648a9bcf4-1.0.4.xpi` | Mozilla Archive Copy | 87,139 B | `f7f8f6044b4daf56b1519825798ad8884bc4500585b921b5803b5ee295692b59` | **Byte-Identical to XPI** |
| `SHA256SUMS.txt` | Checksum Manifest | 420 B | `4422e5058fc048fe6d1ad695bce1354fc58cb5e933481ebc6b3e6e89025ce812` | **Verified Manifest** |

---

## 2. GitHub Distribution Details

- **Repository:** `robijoychakma375-hash/tori-download-manager`
- **Release Tag:** `extension-v1.0.4`
- **Release ID:** `442260909`
- **Release Name:** `TORI Browser Companion v1.0.4`
- **Release URL:** [https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.4](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.4)
- **Status:** Published (`draft: false`, `prerelease: false`, `make_latest: "false"`)
- **Direct Asset Download Links:**
  - Firefox Signed XPI: [https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.4/tori-download-manager-firefox-v1.0.4.xpi](https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.4/tori-download-manager-firefox-v1.0.4.xpi)
  - Chromium Extension ZIP: [https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.4/tori-download-manager-extension-v1.0.4.zip](https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.4/tori-download-manager-extension-v1.0.4.zip)
  - Firefox Source ZIP: [https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.4/tori-download-manager-firefox-v1.0.4.zip](https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.4/tori-download-manager-firefox-v1.0.4.zip)
  - Checksum Manifest: [https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.4/SHA256SUMS.txt](https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.4/SHA256SUMS.txt)

---

## 3. Official Website Distribution & Deployment

- **Website Project:** `C:\Users\ritud\Downloads\tori-website`
- **Remote Repository:** `robijoychakma375-hash/tori-website-private`
- **Deployment Commit:** `6652b64` (`feat(extension): update browser companion distribution to v1.0.4 with signed Firefox XPI and Chrome ZIP`)
- **Live Production URL:** [https://toridownload.xyz/](https://toridownload.xyz/)
- **Live Extension Endpoints:**
  - Same-Origin One-Click Firefox Install: `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.4.xpi`
  - Direct Chromium Package Download: Points to GitHub `extension-v1.0.4` release ZIP
- **HTTP Header Verification:**
  - `curl -sI https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.4.xpi`
  - `HTTP/1.1 200 OK`
  - `Content-Type: application/x-xpinstall`
  - `Access-Control-Allow-Origin: *`
  - `Server: cloudflare`
- **SHA-256 Verification:** Downloaded XPI from `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.4.xpi` verified identical to official Mozilla signed file (`f7f8f6044b...`).

---

## 4. Real Browser Installation & Security Verification

Executed automated install verification script `scripts/test_firefox_v1_0_4_signed_install.js` against standard Mozilla Firefox binary with strict signature enforcement:
- **Marionette Remote Agent:** Connected on port 2828
- **Enforced Settings:** `xpinstall.signatures.required: true`, `temporary: false` (permanent installation test)
- **Install Result:** `Addon:Install` succeeded immediately
- **Installed Add-on ID:** `tori-download-manager@toridm.org`
- **WebExtension Policy URL:** `moz-extension://74a513c2-4544-48db-abe5-f1e375088986/`
- **Signature Verification:** **PASS (Official Mozilla signature valid)**

---

## 5. Desktop Release & Auto-Updater Safety Audit

| Verification Check | Target | Live Verified State | Safety Status |
|---|---|---|:---:|
| **GitHub Latest Release** | Desktop `v1.0.3` | `tag_name: "v1.0.3"` (ID: 442083394) | **SAFE — UNCHANGED** |
| **Public Updater Manifest** | `releases/latest/download/latest.json` | `version: "1.0.3"` | **SAFE — UNCHANGED** |
| **Updater Signatures** | Windows x86_64 / NSIS signatures | Untouched, valid for Desktop v1.0.3 binary | **SAFE — UNCHANGED** |
| **Historical Release Tags** | `v1.0.0`, `v1.0.1`, `v1.0.2`, `v1.0.3` | All tags and assets preserved | **SAFE — UNCHANGED** |
| **Historical v1.0.3 XPI** | `assets/tori-download-manager-firefox-v1.0.3.xpi` | HTTP 200 OK (`88,449 bytes`) | **ACCESSIBLE** |

---

## 6. Git Traceability

- **Branch:** `extension/v1.0.4`
- **Base Checkpoint:** `7a4dcab` (`checkpoint-post-ui-redesign`)
- **Tagged Release:** `extension-v1.0.4` at commit `cb87c9d`
- **Pushed to Remote:** `origin/extension/v1.0.4` and `origin/refs/tags/extension-v1.0.4`
- **Working Tree:** Clean
