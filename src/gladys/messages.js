// -----------------------------------------------------------------------------
// User-facing texts (en/fr) for the Frigate client's outcomes: errors, TLS
// trust decisions, authentication mode. Shown in the connection status and
// as the answer of the manifest action buttons. Never includes a secret: the
// typed errors of src/frigate/errors.js carry none.
// -----------------------------------------------------------------------------

import {
  AuthError,
  CertificateError,
  HttpStatusError,
  MqttRefusedError,
  UnreachableError,
  UnsupportedVersionError,
} from '../frigate/errors.js';
import { TRUST_REASONS } from '../frigate/tlsTrust.js';

/** "AB:CD:EF:01:…:7A:8B:9C:0D" — enough to compare with openssl's output. */
export function shortFingerprint(fingerprint) {
  const pairs = String(fingerprint ?? '').split(':');
  return pairs.length > 8
    ? `${pairs.slice(0, 4).join(':')}:…:${pairs.slice(-4).join(':')}`
    : String(fingerprint ?? '');
}

const UNREACHABLE = {
  TIMEOUT: { en: 'it did not answer in time', fr: "il n'a pas répondu à temps" },
  ECONNREFUSED: {
    en: 'the connection was refused, check the address and the port',
    fr: "la connexion a été refusée, vérifiez l'adresse et le port",
  },
  ENOTFOUND: { en: 'the host name is unknown', fr: "le nom d'hôte est inconnu" },
  EHOSTUNREACH: { en: 'the host is unreachable', fr: "l'hôte est injoignable" },
  ECONNRESET: { en: 'the connection was reset', fr: 'la connexion a été coupée' },
};

/**
 * @param {Error} err
 * @param {string} [what] who failed, e.g. { en: 'Frigate', fr: 'Frigate' }
 * @returns {{ en: string, fr: string }}
 */
export function describeError(err, what = { en: 'Frigate', fr: 'Frigate' }) {
  if (err instanceof CertificateError) {
    const short = shortFingerprint(err.fingerprint);
    if (err.reason === TRUST_REASONS.CERTIFICATE_CHANGED) {
      return {
        en: `The certificate of ${err.endpoint} changed (now SHA-256 ${short}). If you expect it (reinstall, renewed certificate), press "Trust the new certificate"; otherwise someone may be impersonating ${what.en}.`,
        fr: `Le certificat de ${err.endpoint} a changé (désormais SHA-256 ${short}). Si c'est attendu (réinstallation, certificat renouvelé), cliquez sur « Faire confiance au nouveau certificat » ; sinon, quelqu'un se fait peut-être passer pour ${what.fr}.`,
      };
    }
    if (err.reason === TRUST_REASONS.MANUAL_PIN_MISMATCH) {
      return {
        en: `The certificate of ${err.endpoint} (SHA-256 ${short}) does not match the pinned fingerprint of the expert settings.`,
        fr: `Le certificat de ${err.endpoint} (SHA-256 ${short}) ne correspond pas à l'empreinte épinglée des réglages experts.`,
      };
    }
    return {
      en: `The certificate of ${err.endpoint} is not signed by your certificate authority, or does not match the host name.`,
      fr: `Le certificat de ${err.endpoint} n'est pas signé par votre autorité de certification, ou ne correspond pas au nom d'hôte.`,
    };
  }
  if (err instanceof AuthError) {
    const texts = {
      invalid_credentials: {
        en: 'Frigate refused the username or the password.',
        fr: "Frigate a refusé l'utilisateur ou le mot de passe.",
      },
      credentials_required: {
        en: 'Frigate requires a username and a password on this port.',
        fr: 'Frigate demande un utilisateur et un mot de passe sur ce port.',
      },
      rate_limited: {
        en: 'Too many failed logins: Frigate blocks new attempts for a while. Check the password, then try again later.',
        fr: 'Trop de connexions échouées : Frigate bloque les tentatives pendant un moment. Vérifiez le mot de passe, puis réessayez plus tard.',
      },
      forbidden: {
        en: 'The Frigate account is not allowed to read this (role).',
        fr: "Le compte Frigate n'a pas le droit de lire ceci (rôle).",
      },
    };
    return texts[err.code] ?? texts.invalid_credentials;
  }
  if (err instanceof MqttRefusedError) {
    const texts = {
      invalid_credentials: {
        en: 'the broker refused the username or the password',
        fr: "le broker a refusé l'utilisateur ou le mot de passe",
      },
      not_authorized: {
        en: 'the broker refused this account (not authorized)',
        fr: 'le broker a refusé ce compte (non autorisé)',
      },
      refused: { en: 'the broker refused the connection', fr: 'le broker a refusé la connexion' },
    };
    const text = texts[err.code] ?? texts.refused;
    return { en: `${what.en}: ${text.en}.`, fr: `${what.fr} : ${text.fr}.` };
  }
  if (err instanceof UnreachableError) {
    const reason = UNREACHABLE[err.code] ?? {
      en: `network error ${err.code}`,
      fr: `erreur réseau ${err.code}`,
    };
    return {
      en: `Cannot reach ${what.en}: ${reason.en}.`,
      fr: `Impossible de joindre ${what.fr} : ${reason.fr}.`,
    };
  }
  if (err instanceof UnsupportedVersionError) {
    return {
      en: `Frigate ${err.version} is not supported: version 0.16 or later is required.`,
      fr: `Frigate ${err.version} n'est pas pris en charge : la version 0.16 ou plus est nécessaire.`,
    };
  }
  if (err instanceof HttpStatusError) {
    return {
      en: `${what.en} answered with an error (HTTP ${err.status} on ${err.path}).`,
      fr: `${what.fr} a répondu par une erreur (HTTP ${err.status} sur ${err.path}).`,
    };
  }
  return {
    en: `Unexpected error with ${what.en}: ${err?.message ?? err}.`,
    fr: `Erreur inattendue avec ${what.fr} : ${err?.message ?? err}.`,
  };
}

/** How the certificate was trusted; null decision = plain http. */
export function describeTls(decision) {
  if (!decision) {
    return { en: 'none (http)', fr: 'aucun (http)' };
  }
  const short = shortFingerprint(decision.fingerprint);
  switch (decision.reason) {
    case TRUST_REASONS.CA_VERIFIED:
      return {
        en: 'verified by a certificate authority',
        fr: 'vérifié par une autorité de certification',
      };
    case TRUST_REASONS.FIRST_USE:
      return {
        en: `self-signed, trusted on this first connection and pinned (SHA-256 ${short})`,
        fr: `auto-signé, approuvé à cette première connexion et épinglé (SHA-256 ${short})`,
      };
    case TRUST_REASONS.PINNED:
      return {
        en: `self-signed, identical to the pinned one (SHA-256 ${short})`,
        fr: `auto-signé, identique à celui épinglé (SHA-256 ${short})`,
      };
    case TRUST_REASONS.MANUAL_PIN:
      return {
        en: 'matches the fingerprint of the expert settings',
        fr: "correspond à l'empreinte des réglages experts",
      };
    default:
      return { en: `refused (${decision.reason})`, fr: `refusé (${decision.reason})` };
  }
}

/** How the HTTP client authenticated (client.authMode). */
export function describeAuth(mode, username) {
  switch (mode) {
    case 'token':
      return { en: `logged in as ${username}`, fr: `connecté en tant que ${username}` };
    case 'disabled':
      return {
        en: 'authentication is disabled in Frigate',
        fr: "l'authentification est désactivée dans Frigate",
      };
    default:
      return {
        en: 'this port requires no authentication',
        fr: "ce port ne demande pas d'authentification",
      };
  }
}
