// German user-facing texts the browser shows as they are. Model-facing tool diagnostics stay English.
export function inMinutes(seconds) {
  const s = Math.max(1, Math.ceil(seconds));
  if (s <= 60) return '1 Minute';
  const minutes = Math.ceil(s / 60);
  if (minutes < 120) return `${minutes} Minuten`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? '1 Stunde' : `${hours} Stunden`;
}

export const tooManyAttempts = (seconds) => `Zu viele Versuche – bitte in ${inMinutes(seconds)} erneut`;
export const waitAndRetry = (what, seconds) => `${what} – bitte in ${inMinutes(seconds)} erneut`;

/** Fixed texts, so tests and the web app can rely on them. */
export const TEXT = {
  wrongCode: 'Code stimmt nicht',
  loginNotConfigured: 'Die Anmeldung ist auf dem Server nicht eingerichtet',
  badNext: 'Ungültiges Ziel für den Login-Link',
  linkLimited: (when) => `Ein Login-Link wurde gerade erst geschickt – bitte in ${when} erneut anfordern`,
  linkNotSent: 'Der Login-Link konnte nicht per Telegram geschickt werden – bitte später erneut versuchen',
  loginRequired: 'Bitte zuerst anmelden',
  badOrigin: 'Anfrage von einer fremden Seite abgelehnt',
  notFound: 'Nicht gefunden',
  methodNotAllowed: 'Diese Methode ist hier nicht erlaubt',
  internal: 'Interner Fehler – bitte gleich nochmal versuchen',
  bodyTooLarge: 'Die Anfrage ist zu groß',
  badJson: 'Die Anfrage ist kein gültiges JSON',
  badMessages: 'Die Nachrichtenliste ist ungültig: sie muss mit einer Nachricht von dir enden',
  spendCap: 'Das Tageslimit für Kosten ist erreicht',
  voiceBusy: 'Es laufen schon zu viele Sprachsitzungen',
  voiceMinutes: 'Die Sprachminuten für heute sind aufgebraucht',
  textModelMissing: 'Das Textmodell ist nicht eingerichtet',
  explainerPath: 'Ungültiger Pfad der Erklärseite',
  explainerDown: 'Die Erklärseite ist gerade nicht erreichbar',
  explainerMissing: 'Diese Datei der Erklärseite gibt es nicht',
  transcribeMissing: 'Diktat ist nicht eingerichtet',
  transcribeType: 'Bitte Audio als webm, wav, ogg, mp4 oder mp3 senden',
  transcribeShort: 'Die Aufnahme ist zu kurz',
  transcribeNoCredit: 'Der Diktat-Anbieter hat kein Guthaben mehr',
  transcribeFailed: 'Das Diktat hat nicht geklappt',
  bridgeOffline: (host) => `Die Werkstatt-Verbindung (${host}) ist offline`,
  bridgeLost: (host) => `Die Werkstatt-Verbindung (${host}) wurde getrennt`,
  bridgeSlow: 'Die Werkstatt hat nicht rechtzeitig geantwortet',
  badSession: 'Ungültige Session-ID',
  badHost: 'Ungültiger Host',
  promptRequired: 'Bitte eine Aufgabe angeben (höchstens 20.000 Zeichen)',
  textRequired: 'Bitte einen Text angeben (höchstens 20.000 Zeichen)',
  badModel: 'Das Modell muss „opus“ oder „sonnet“ sein',
  claudeBusy: (max) => `Es laufen schon ${max} Claude-Sessions`,
  claudeDaily: 'Das Tageslimit für Claude-Sessions ist erreicht',
};

/** OpenRouter / model errors by HTTP status. */
export function modelError(status) {
  if (status === 401 || status === 403) return 'Der Zugang zum Textmodell wurde abgelehnt';
  if (status === 402) return 'Beim Textmodell-Anbieter ist kein Guthaben mehr da';
  if (status === 429) return 'Der Textmodell-Anbieter ist gerade überlastet – bitte gleich nochmal';
  return `Das Textmodell hat nicht geantwortet (Fehler ${status})`;
}
