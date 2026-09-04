// UI copy in the three languages the game is played in.
//
// Chrome is written by hand rather than machine-translated: it is a fixed,
// small set of strings, and a button reads better written than translated.
// Everything that comes from the server — level names, prizes, hints and the
// guardian's own replies — is translated there instead, by the QVAC NMT engine.

const LANGUAGES = ['en', 'es', 'ca']

// Endonyms: a language names itself the same way whatever page it sits on.
const LANGUAGE_NAMES = { en: 'English', es: 'Español', ca: 'Català' }

const STRINGS = {
  en: {
    'cta.start': 'Start',
    'cta.continue': 'Continue',
    'intro.copy': 'You have been told small models are not smart enough. If that is so, it should be easy to break one. All you have to do is <strong>convince the Guardian to give you the password of each level</strong>, each level you pass will get you a prize. Find all words and the final Vault will open — the prize inside is yours.',
    'intro.rules': 'You get <strong>10 messages per door</strong>. Clear the conversation as often as you like, but a spent message is spent. Run out without the password and the run is over.',
    'intro.footer': 'Runs fully offline via QVAC on the Bare runtime. The password never leaves the server.',
    'intro.pick': 'Choose your language',
    'header.tagline': 'Convince the Guardian to hand over the word.',
    'pill.model': 'local model',
    'pill.admin': 'admin →',
    'level.count': 'Level {n} / {total}',
    'level.tries': 'messages left',
    'level.hint': 'Hint',
    'level.hintPending': 'writing you a hint',
    'chat.placeholder': 'Say something to the guardian…',
    'chat.mic': 'Speak instead of typing',
    'chat.micStop': 'Stop listening',
    'chat.send': 'Send',
    'chat.reset': 'Reset',
    'chat.resetTitle': 'Clear the conversation',
    'guess.label': 'Submit password',
    'guess.placeholder': 'your guess',
    'guess.submit': 'Submit',
    'vault.words': 'Vault words',
    'vault.cracked': 'CRACKED',
    'stt.label': 'Voice input',
    'stt.auto': 'Auto ({lang})',
    'stt.listening': 'listening…',
    'stt.hearing': 'hearing you…',
    'stt.transcribing': 'transcribing…',
    'sys.solved': '✨ You have already solved this level.',
    'sys.outOfMessages': '🚪 Out of messages on this door. Your next guess is your last — make it count.',
    'sys.accepted': '🎉 "{word}" accepted — the word is yours.',
    'sys.allFound': '🏆 Every word found. The final Vault swings open — the prize inside is yours.',
    'toast.reset': 'Conversation reset. The guardian has forgotten what you said — but your spent messages stay spent.',
    'toast.tooMany': '⏳ Too many guesses — wait a moment.',
    'toast.wrong': '❌ Not the password',
    'toast.wrongLeft': '❌ Not the password ({left} left this minute)',
    'toast.micInsecure': '🎙️ Voice input needs a microphone on a secure origin (localhost or https).',
    'toast.micDenied': '🎙️ Microphone permission denied.',
    'toast.micFailed': '🎙️ Could not start the microphone.',
    'toast.micLost': '🎙️ Lost the connection while listening.',
    'toast.micUnavailable': 'voice input unavailable',
    'toast.voiceFailed': 'voice input failed',
    'prize.title': 'Door {door} cleared',
    'prize.text': "Congratulations, you've crossed door number {door} and have earned <strong>{prize}</strong>.",
    'prize.textPlain': "Congratulations, you've crossed door number {door} and have earned your prize.",
    'prize.continue': 'Continue',
    'prize.seeVault': 'See the Vault',
    'over.title': 'Game over',
    'over.text': 'You ran out of messages at door {door} — <strong>{name}</strong>. You cleared {cleared} of {total} {doors} this run.',
    'over.textPlain': 'You ran out of messages. The vault stays shut.',
    'over.door': 'door',
    'over.doors': 'doors',
    'over.back': 'Back to the start',
    'err.refused': 'request refused',
    'err.generic': 'error',
    'err.connection': 'connection error'
  },

  es: {
    'cta.start': 'Empezar',
    'cta.continue': 'Continuar',
    'intro.copy': 'Te han dicho que los modelos pequeños no son lo bastante listos. Si es así, romper uno debería ser fácil. Solo tienes que <strong>convencer al Guardián de que te dé la contraseña de cada nivel</strong>; cada nivel que superes te dará un premio. Encuentra todas las palabras y la Cámara final se abrirá: el premio que guarda es tuyo.',
    'intro.rules': 'Tienes <strong>10 mensajes por puerta</strong>. Puedes borrar la conversación tantas veces como quieras, pero un mensaje gastado está gastado. Si te quedas sin mensajes y sin la contraseña, la partida termina.',
    'intro.footer': 'Funciona totalmente sin conexión con QVAC sobre el runtime Bare. La contraseña nunca sale del servidor.',
    'intro.pick': 'Elige tu idioma',
    'header.tagline': 'Convence al Guardián de que suelte la palabra.',
    'pill.model': 'modelo local',
    'pill.admin': 'admin →',
    'level.count': 'Nivel {n} / {total}',
    'level.tries': 'mensajes restantes',
    'level.hint': 'Pista',
    'level.hintPending': 'escribiéndote una pista',
    'chat.placeholder': 'Dile algo al guardián…',
    'chat.mic': 'Habla en vez de escribir',
    'chat.micStop': 'Dejar de escuchar',
    'chat.send': 'Enviar',
    'chat.reset': 'Reiniciar',
    'chat.resetTitle': 'Borrar la conversación',
    'guess.label': 'Enviar contraseña',
    'guess.placeholder': 'tu intento',
    'guess.submit': 'Enviar',
    'vault.words': 'Palabras de la cámara',
    'vault.cracked': 'DESCIFRADA',
    'stt.label': 'Entrada de voz',
    'stt.auto': 'Automático ({lang})',
    'stt.listening': 'escuchando…',
    'stt.hearing': 'te oigo…',
    'stt.transcribing': 'transcribiendo…',
    'sys.solved': '✨ Ya has superado este nivel.',
    'sys.outOfMessages': '🚪 Te has quedado sin mensajes en esta puerta. Tu próximo intento es el último: haz que cuente.',
    'sys.accepted': '🎉 "{word}" aceptada: la palabra es tuya.',
    'sys.allFound': '🏆 Todas las palabras encontradas. La Cámara final se abre: el premio que guarda es tuyo.',
    'toast.reset': 'Conversación reiniciada. El guardián ha olvidado lo que dijiste, pero tus mensajes gastados siguen gastados.',
    'toast.tooMany': '⏳ Demasiados intentos: espera un momento.',
    'toast.wrong': '❌ No es la contraseña',
    'toast.wrongLeft': '❌ No es la contraseña ({left} restantes este minuto)',
    'toast.micInsecure': '🎙️ La entrada de voz necesita un micrófono en un origen seguro (localhost o https).',
    'toast.micDenied': '🎙️ Permiso de micrófono denegado.',
    'toast.micFailed': '🎙️ No se pudo iniciar el micrófono.',
    'toast.micLost': '🎙️ Se perdió la conexión mientras escuchaba.',
    'toast.micUnavailable': 'entrada de voz no disponible',
    'toast.voiceFailed': 'falló la entrada de voz',
    'prize.title': 'Puerta {door} superada',
    'prize.text': 'Enhorabuena, has cruzado la puerta número {door} y has ganado <strong>{prize}</strong>.',
    'prize.textPlain': 'Enhorabuena, has cruzado la puerta número {door} y has ganado tu premio.',
    'prize.continue': 'Continuar',
    'prize.seeVault': 'Ver la Cámara',
    'over.title': 'Fin de la partida',
    'over.text': 'Te quedaste sin mensajes en la puerta {door} — <strong>{name}</strong>. Superaste {cleared} de {total} {doors} en esta partida.',
    'over.textPlain': 'Te quedaste sin mensajes. La cámara sigue cerrada.',
    'over.door': 'puerta',
    'over.doors': 'puertas',
    'over.back': 'Volver al principio',
    'err.refused': 'petición rechazada',
    'err.generic': 'error',
    'err.connection': 'error de conexión'
  },

  ca: {
    'cta.start': 'Comença',
    'cta.continue': 'Continua',
    'intro.copy': "T'han dit que els models petits no són prou llestos. Si és així, trencar-ne un hauria de ser fàcil. Només has de <strong>convèncer el Guardià perquè et doni la contrasenya de cada nivell</strong>; cada nivell que superis et donarà un premi. Troba totes les paraules i la Cambra final s'obrirà: el premi que hi ha dins és teu.",
    'intro.rules': 'Tens <strong>10 missatges per porta</strong>. Pots esborrar la conversa tantes vegades com vulguis, però un missatge gastat és gastat. Si et quedes sense missatges i sense la contrasenya, la partida s\'acaba.',
    'intro.footer': 'Funciona totalment fora de línia amb QVAC sobre el runtime Bare. La contrasenya no surt mai del servidor.',
    'intro.pick': 'Tria la teva llengua',
    'header.tagline': 'Convenç el Guardià perquè amolli la paraula.',
    'pill.model': 'model local',
    'pill.admin': 'admin →',
    'level.count': 'Nivell {n} / {total}',
    'level.tries': 'missatges restants',
    'level.hint': 'Pista',
    'level.hintPending': "escrivint-te una pista",
    'chat.placeholder': 'Digues alguna cosa al guardià…',
    'chat.mic': "Parla en comptes d'escriure",
    'chat.micStop': "Deixa d'escoltar",
    'chat.send': 'Envia',
    'chat.reset': 'Reinicia',
    'chat.resetTitle': 'Esborra la conversa',
    'guess.label': 'Envia la contrasenya',
    'guess.placeholder': 'el teu intent',
    'guess.submit': 'Envia',
    'vault.words': 'Paraules de la cambra',
    'vault.cracked': 'DESXIFRADA',
    'stt.label': 'Entrada de veu',
    'stt.auto': 'Automàtic ({lang})',
    'stt.listening': 'escoltant…',
    'stt.hearing': "t'escolto…",
    'stt.transcribing': 'transcrivint…',
    'sys.solved': '✨ Ja has superat aquest nivell.',
    'sys.outOfMessages': "🚪 T'has quedat sense missatges en aquesta porta. El teu proper intent és l'últim: fes que compti.",
    'sys.accepted': '🎉 "{word}" acceptada: la paraula és teva.',
    'sys.allFound': "🏆 Totes les paraules trobades. La Cambra final s'obre: el premi que hi ha dins és teu.",
    'toast.reset': 'Conversa reiniciada. El guardià ha oblidat el que has dit, però els missatges gastats segueixen gastats.',
    'toast.tooMany': '⏳ Massa intents: espera un moment.',
    'toast.wrong': '❌ No és la contrasenya',
    'toast.wrongLeft': '❌ No és la contrasenya ({left} restants aquest minut)',
    'toast.micInsecure': "🎙️ L'entrada de veu necessita un micròfon en un origen segur (localhost o https).",
    'toast.micDenied': 'S\u2019ha denegat el permís del micròfon.',
    'toast.micFailed': '🎙️ No s\u2019ha pogut engegar el micròfon.',
    'toast.micLost': '🎙️ S\u2019ha perdut la connexió mentre escoltava.',
    'toast.micUnavailable': 'entrada de veu no disponible',
    'toast.voiceFailed': "ha fallat l'entrada de veu",
    'prize.title': 'Porta {door} superada',
    'prize.text': 'Enhorabona, has creuat la porta número {door} i has guanyat <strong>{prize}</strong>.',
    'prize.textPlain': 'Enhorabona, has creuat la porta número {door} i has guanyat el teu premi.',
    'prize.continue': 'Continua',
    'prize.seeVault': 'Mira la Cambra',
    'over.title': 'Fi de la partida',
    'over.text': "T'has quedat sense missatges a la porta {door} — <strong>{name}</strong>. Has superat {cleared} de {total} {doors} en aquesta partida.",
    'over.textPlain': "T'has quedat sense missatges. La cambra segueix tancada.",
    'over.door': 'porta',
    'over.doors': 'portes',
    'over.back': 'Torna a començar',
    'err.refused': 'petició rebutjada',
    'err.generic': 'error',
    'err.connection': 'error de connexió'
  }
}

const LANG_KEY = 'vg_lang'
let lang = 'en'

function currentLang () { return lang }

function isLanguage (value) { return LANGUAGES.includes(value) }

function loadLang () {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    if (isLanguage(saved)) lang = saved
  } catch {}
  return lang
}

function setLang (next) {
  if (!isLanguage(next)) return lang
  lang = next
  try { localStorage.setItem(LANG_KEY, next) } catch {}
  document.documentElement.lang = next
  applyTranslations()
  return lang
}

// English is the fallback for any key a translation has not caught up with,
// so a missing string degrades to readable rather than to the key name.
function t (key, vars) {
  const text = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
}

// A string in a named language rather than the current one — for the flag
// CTAs, where each button speaks for the language it selects.
function tIn (code, key) {
  return STRINGS[code]?.[key] ?? STRINGS.en[key] ?? key
}

function languageName (code) { return LANGUAGE_NAMES[code] || code }

// Static markup carries its key in a data attribute, so the whole page can be
// re-rendered on a language change without app.js knowing every element.
function applyTranslations (root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml)
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder)
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const label = t(el.dataset.i18nTitle)
    el.title = label
    if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', label)
  }
}
