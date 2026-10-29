// docs/UPGRADES-1028.md §4: every string from any tool passes redact(); gateway and bridge scrub the same way.
// All values below are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { redact as gwRedact, short } from '../src/redact.js';
import { redact as bridgeRedact } from '../../bridge/src/redact.js';
import { syn } from './synthetic.js';

const SECRET = [
  ['cookie header', syn('Cookie: sessionid=abc123def; csrftoken=zzz·999'), 'abc123def'],
  ['set-cookie header', syn('set-cookie: __Se·cure·-sid·=QWE·RTY1·2345; Path=/; HttpOnly'), 'QWERTY12345'],
  ['cookie json', '{"cookie": "sid=S3cr3tValue; other=1"}', 'S3cr3tValue'],
  ['password= short', syn('login with password=hun·ter2 please'), 'hunter2'],
  ['Passwort:', syn('Passwort: Som·mer24!'), 'Sommer24!'],
  ['code colon', 'Code: 482913', '482913'],
  ['german confirmation', 'Ihr Bestätigungscode lautet 739201.', '739201'],
  ['german confirmation colon', 'Dein Sicherheitscode lautet: 551 902', '551 902'],
  ['english verification', 'Your verification code is 104857', '104857'],
  ['number first', '839104 ist dein Bestätigungscode für Beispiel', '839104'],
  ['google', 'G-552910 is your Google verification code', '552910'],
  ['tan', 'mTAN: 66120394', '66120394'],
  ['pin', 'PIN 4711', '4711'],
  ['reset link', syn('Reset: https://accounts.example.com/reset-password?toke·n=ab·cdef·ghij·klmn·opqr·stuv·wxyz·0123'), syn('abcd·efgh·ijkl·mnop·qrst·uvwx·yz01·23')],
  ['magic link path', 'https://app.example.org/auth/magic/Zx8yQ2wE5rT7uI9oP1aS3dF6gH0jK4lL', syn('Zx8y·Q2wE·5rT7·uI9o·P1aS·3dF6·gH0j·K4lL')],
  ['private key pem', syn(`-----${'BEGIN'} OPENSSH PRIVATE KEY-----\nb3B·lbnN·zaC1·rZXk·tdjE·AAAA·A\n-----${'END'} OPENSSH PRIVATE KEY-----`), syn('b3Bl·bnNz·aC1r·ZXkt·djEA·AAAA')],
  ['private key cut off', syn(`-----${'BEGIN'} PRIVATE KEY-----\nMII·EvQI·BADA·NBgk·qhki·G9w0·BAQE·FAAS·C`), syn('MIIE·vQIB·ADAN·Bgkq·hkiG·9w0B·AQEF·AASC')],
  ['hex private key', 'private key: 0x' + 'ab'.repeat(32), 'ab'.repeat(32)],
  ['seed phrase', 'seed phrase: ' + 'apple river stone cloud ocean tiger music paper glass horse candle rocket', 'tiger music paper'],
  ['mnemonic json', '"mnemonic": "' + Array(24).fill('zebra').join(' ') + '"', 'zebra zebra'],
  ['env line', syn('OPEN·ROUT·ER_A·PI_K·EY=o·r-v1·-syn·thet·ic-1·23'), 'or-v1-synthetic-123'],
  ['env export quoted', 'export DB_PASSWORD="x1"', '"x1"'],
  ['env token short', 'TELEGRAM_BOT_TOKEN=12:ab', '12:ab'],
  ['url credentials', 'postgres://desk:Sup3rS3cret@db.internal:5432/x', 'Sup3rS3cret'],
  ['sk key', 'key sk-abcdefghijklmnop1234 here', 'sk-abcdefghijklmnop1234'],
  ['bearer', syn('Authorization: Bearer abcd·efgh·ijkl·mnop·qrst·uvwx·yz01·2345'), syn('abcd·efgh·ijkl·mnop·qrst·uvwx·yz01·2345')],
  ['jwt', ['eyJhbGciOiJIUzI1NiJ9', syn('eyJz·dWIi·OiIx·MjM0·NTY3·ODkw·In0'), syn('dozj·gNry·P4J3·jVmN·Hl0w·5N_X·gL0n·3I9P·lFUP·0THs·R8U')].join('.'), syn('dozj·gNry·P4J3·jVmN·Hl0w·5N')],
  ['json access_token', syn('{"access_token": "ya29·.a0S·ynth·etic·Toke·nVal·ue12·3456·7890"}'), syn('ya29·.a0S·ynth·etic·Toke·nVal·ue12·3456·7890')],
  ['json api_key', syn('{"api_key":"synt·heti·c_9f·8e7d·6c5b·4a39·28"}'), syn('synt·heti·c_9f·8e7d·6c5b·4a39·28')],
  ['json password', syn('{"password":"Hun·ter2Synth!"}'), 'Hunter2Synth!'],
  ['json credential key', syn('{"client_credentials": "Synt·heti·cCre·d99"}'), 'SyntheticCred99'],
  ['cookie object', syn('{"name":"sid","value":"Synt·heti·cCoo·kieV·alue·0123·4567·89","domain":".example.test"}'), syn('Synt·heti·cCoo·kieV·alue·0123·4567·89')],
  ['cookie object value first', syn('{"value":"Synt·heti·cCoo·kieV·alue·0123·4567·89","name":"sid","domain":".example.test"}'), syn('Synt·heti·cCoo·kieV·alue·0123·4567·89')],
  ['telegram bot token', 'bot 8123456789:AAH' + syn('Synt·heti·cBot·Toke·nVal·ue_0·1234·5678·9ab'), syn('Synt·heti·cBot·Toke·nVal·ue_0·1234·5678·9ab')],
  ['basic auth', 'authorization: Basic ' + syn('dXNl·cjpz·eW50·aGV0·aWNw·dw=='), syn('dXNl·cjpz·eW50·aGV0·aWNw·dw')],
  ['hf token', ['hf', syn('Synt·heti·cHug·ging·Face·Toke·n012·3456·789')].join('_'), syn('Synt·heti·cHug·ging·Face·Toke·n012·3456·789')],
  ['rpa token', ['rpa', syn('SYNT·HETI·CRUN·PODK·EY01·2345·6789·ABCD·EF')].join('_'), syn('SYNT·HETI·CRUN·PODK·EY01·2345·6789·ABCD·EF')],
  ['npm token', ['npm', syn('Synt·heti·cNpm·Toke·n012·3456·789a·bcde·fABC·D')].join('_'), syn('Synt·heti·cNpm·Toke·n012·3456·789a·bcde·fABC·D')],
  ['r8 token', ['r8', syn('Synt·heti·cRep·lica·teTo·ken0·1234·5678·9abc·def')].join('_'), syn('Synt·heti·cRep·lica·teTo·ken0·1234·5678·9abc·def')],
  ['gitlab token', ['glpat', syn('Synt·heti·cGit·labT·oken·0123·4567·89')].join('-'), syn('Synt·heti·cGit·labT·oken·0123·4567·89')],
  ['slack token', ['xoxb', syn('0123·4567·89-S·ynth·etic·Slac·k')].join('-'), 'SyntheticSlack'],
  ['stripe live key', ['sk', 'live', syn('Synt·heti·cStr·ipeK·ey01·2345·6789')].join('_'), syn('Synt·heti·cStr·ipeK·ey01·2345·6789')],
  ['stripe restricted key', ['rk', 'live', syn('Synt·heti·cStr·ipeK·ey01·2345·6789')].join('_'), syn('Synt·heti·cStr·ipeK·ey01·2345·6789')],
  ['env colon form', 'DESK_ACCESS_CODE: ab12-cd34-ef56', 'ab12-cd34-ef56'],
  ['access code dashed', 'Ich hab den Access-Code 7781-2234 gesetzt', '7781-2234'],
  ['zugangscode', 'Der Zugangscode 7781-2234 gilt heute', '7781-2234'],
  // critic round 2, P0-1: quoted key/value in Python dict reprs, os.environ dumps and JS objects
  ['python env dump', syn("clean = {'SYNTH_ABLITERATION_API_KEY': 'aa_9·aAA9·synt·hVal·ue01·2345·6789·abcd·efgh·ij', 'AGENT_BOARD_JOBDIR': '/tmp/x'}"), 'aa_9aAA9synthValue'],
  ['os.environ repr', syn("environ({'HOME': '/home/x', 'CHUTES_FINGERPRINT': 'synt·hFin·gerp·rint·0123·4567·89'})"), syn('synt·hFin·gerp·rint·0123·4567·89')],
  ['lowercase quoted', syn("{'session_cookie': 'synt·hCoo·kie0·1234·5678·9'}"), syn('synt·hCoo·kie0·1234·5678·9')],
  ['double-quoted python', syn('{"X_AUTH_HEADER": "synt·hAut·hVal·ue01·23"}'), syn('synt·hAut·hVal·ue01·23')],
  ['credential key', syn("{'gcp_credential': 'synt·hCre·d.01·2345·6789'}"), syn('synt·hCre·d.01·2345·6789')],
  ['js object', syn("const cfg = { 'clientPass': 'synt·hPas·sVal·ue99' };"), 'synthPassValue99'],
  // critic round 2, P1-1 (scripts/redact2.mjs): the seven formats that still passed
  ['aws ini', syn('aws_secret_acc·ess_key = synt·hFak·e012·3456·789a·bcde·fghi·jklm·nopq·rstu·v'), syn('synt·hFak·e012·3456·789a·bcde·fghi·jklm·nopq·rstu·v')],
  ['stripe webhook secret', ['whsec', syn('synt·hfak·e012·3456·789a·bcde·fgh')].join('_'), syn('synt·hfak·e012·3456·789a·bcde·fgh')],
  ['slack webhook url', 'https://hooks.slack.com/services/T0SYNTH/B0FAKE/synthfake0123456789abcdef', syn('synt·hfak·e012·3456·789a·bcde·f')],
  ['discord webhook url', 'https://discord.com/api/webhooks/123456789012345678/synthWebhook0123456789abcdefABCDEF', syn('synt·hWeb·hook·0123·4567·89')],
  ['camelCase privateKey json', syn('"privateKey": "synt·hPri·vKey·Json·Valu·e012·3456·789"'), syn('synt·hPri·vKey·Json·Valu·e012·3456·789')],
  ['camelCase clientSecret json', syn('{"clientSecret": "synt·hCli·entS·ecre·t012·3"}'), syn('synt·hCli·entS·ecre·t012·3')],
  ['camelCase accessToken js', syn('const accessToken = "synt·hAcc·essT·oken·0123·456"'), syn('synt·hAcc·essT·oken·0123·456')],
  ['single-quoted api_key', syn("{'api_key': 'synt·hSin·gleQ·uote·d012·3456·789'}"), syn('synt·hSin·gleQ·uote·d012·3456·789')],
  ['kennwort lautet', 'Kennwort lautet Sommer2026!', 'Sommer2026!'],
  ['passwort ist', 'Das Passwort ist Winter#2026', 'Winter#2026'],
  ['key space hex', syn('session_secret 9f8e·7d6c·5b4a·3928·1706·f5e4·d3c2·b1a0·9f8e·7d6c·5b4a·3928'), syn('9f8e·7d6c·5b4a·3928·1706·f5e4·d3c2·b1a0·9f8e·7d6c·5b4a·3928')],
  ['key space base64', syn('api_token AbCd·Ef01·2345·6789·GhIj·KlMn·OpQr·StUv·Wx'), syn('AbCd·Ef01·2345·6789·GhIj·KlMn·OpQr·StUv·Wx')],
  ['yaml lowercase', syn('api_key: synt·hYam·lVal·ue01·2345·6789·abcd·ef'), syn('synt·hYam·lVal·ue01·2345·6789·abcd·ef')],
  // critic round 3, P1-1 (scripts/redact3.mjs): the eight formats that still passed
  ['google oauth client secret', `client: ${['GOCSPX', syn('Synt·hFak·eOau·th01·2345·6789·abcd')].join('-')}`, syn('Synt·hFak·eOau·th01·2345·6789·abcd')],
  ['snippet starts mid-key', syn('ET=Z·q8xW·2vK9·mPa4·rT7y·B1nC·5dE3·fG6h·J0\\nFUSION_PARENT=/home/flori/jobs/x'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE·3fG6·hJ0')],
  ['bare value at line start in an env dump', syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE·3fG6·hJ0\\nFUSION_PARENT=/home/flori/jobs/x'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE·3fG6·hJ0')],
  ['json in json escaped quotes', syn('{"cmd":"export X=1; echo \\"api_key\\": \\"Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE·3fG6·hJ0\\""}'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE·3fG6·hJ0')],
  ['json in json session key', syn('{"t":"{\\"session_token\\": \\"synt·hSes·s012·3456·789A·BCde·f\\"}"}'), syn('synt·hSes·s012·3456·789A·BCde·f')],
  ['mysql -p', syn('mysql -u root -pZq·8xW2·vK9m·Pa4r·T7 db'), syn('Zq8x·W2vK·9mPa·4rT7')],
  ['mariadb -p quoted', "mariadb -h db -u app -p'Synth pw 99' shop", 'Synth pw 99'],
  ['sshpass', syn("sshpass -p 'Zq8x·W2vK·9mPa·4rT7·yB' ssh x@y"), syn('Zq8x·W2vK·9mPa·4rT7·yB')],
  ['sshpass unquoted', 'sshpass -p SynthPw0123 ssh x@y', 'SynthPw0123'],
  ['--password flag', syn('tool login --password Zq8x·W2vK·9mPa·4rT7'), syn('Zq8x·W2vK·9mPa·4rT7')],
  ['--pass= flag', syn('cli --user me --pass=Synt·hPas·s012·3'), syn('Synt·hPas·s012·3')],
  ['netrc one line', syn('machine api.example.com login florian password Zq8x·W2vK·9mPa·4rT7'), syn('Zq8x·W2vK·9mPa·4rT7')],
  ['netrc multi line', syn('machine api.example.com\n  login florian\n  password Syn·th0123pw!'), 'Synth0123pw!'],
  ['weak key but random value', syn('sessionId: 9f8e·7d6c·5b4a·3928·Aa17'), syn('9f8e·7d6c·5b4a·3928·Aa17')],
  ['bare code with one-time-code shape', 'security alerts (password 12:33Z), code 248913 12:32:48Z', '248913'],
  ['bare code 3+3 digits near passkey', 'Link passkey + code 920 114 (05:38Z)', '920 114'],
  // critic round 4, P1-1 (scripts/redact4.mjs): the formats that still passed (bare 64-hex / WIF keys without context stay out)
  ['telegram token in the api url', `https://api.telegram.org/bot123456789:AAH${syn('Synt·hBot·Toke·n012·3456·789a·bcde·fgh')}/sendMessage`, syn('Synt·hBot·Toke·n012·3456·789')],
  ['docker login -p', syn('docker login -u synth -p Zq8x·W2vK·9mPa·4rT7·yB ghcr.io'), syn('Zq8x·W2vK·9mPa·4rT7·yB')],
  ['echo | docker login --password-stdin', syn("echo 'Zq8x·W2vK·9mPa·4rT7·yB' | docker login ghcr.io -u synth --password-stdin"), syn('Zq8x·W2vK·9mPa·4rT7·yB')],
  ['redis url empty user', syn('redis://:Zq8x·W2vK·9mPa·4rT7·yB@10.0.0.5:6379/0'), syn('Zq8x·W2vK·9mPa·4rT7·yB')],
  ['authorization token scheme', syn('Authorization: Token Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE')],
  ['authorization apikey scheme', syn('authorization: ApiKey synt·hapi·key0·123'), 'synthapikey0123'],
  ['authorization raw value', syn('Authorization: Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE')],
  ['php array password', syn("'password' => 'Zq8x·W2vK·9mPa·4rT7·yB',"), syn('Zq8x·W2vK·9mPa·4rT7·yB')],
  ['upper key space value', syn('COOLIFY_TOKEN Zq8x·W2vK·9mPa·4rT7·yB'), syn('Zq8x·W2vK·9mPa·4rT7·yB')],
  ['upper key tab value', syn('SYNTH_GITHUB_TOKEN\tZq8·xW2v·K9mP·a4rT·7yB'), syn('Zq8x·W2vK·9mPa·4rT7·yB')],
  ['upper key csv value', syn('name,value\nSTRIPE_SECRET,Zq8x·W2vK·9mPa·4rT7·yB'), syn('Zq8x·W2vK·9mPa·4rT7·yB')],
  ['fingerprint prose', syn('fingerprint Zq8x·W2vK·9mPa·4rT7·yB1n·C'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C')],
  ['token is prose', syn('the token is Zq8x·W2vK·9mPa·4rT7·yB1n·C'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C')],
  ['API-Schlüssel', syn('API-Schlüssel: Zq8x·W2vK·9mPa·4rT7·yB1n·C'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C')],
  ['ssh-keygen -N', "ssh-keygen -t ed25519 -N 'Synth pass 2026!' -f key", 'Synth pass 2026!'],
  ['echo | gh auth login', syn('echo Zq8x·W2vK·9mPa·4rT7·yB1n·C | gh auth login --with-token'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C')],
  ['discord user token', ['MTA4NzY1NDMyMTA5ODc2NTQzMg', 'GhIjKl', syn('Synt·hDis·cord·Hmac·0123·4567·89ab·cdEF')].join('.'), syn('Synt·hDis·cord·Hmac·0123·4567·89')],
  ['htpasswd apr1', syn(`admin:${'$apr1$'}Zq8xW2vK$Lk9m·Rt4Y·bN8c·Hs3G·1abc·d/`), syn('Lk9m·Rt4Y·bN8c·Hs3G·1abc·d')],
  ['bcrypt hash', `admin:${'$2y$'}10$${syn('Synt·hBcr·yptS·alt0·1234·56.S·ynth·Bcry·ptHa·shVa·lue0·1234·5678·9')}`, 'SynthBcryptHashValue'],
  // critic round 4, P0-1 (b): a value on the line after a label line
  ['label line then value', syn('Zugang zum Testdienst\n\nName: "beispiel"\n\nClient secret\nZq8·xW2v·K9mP·a4rT·7yB1·nC5d·E3fG·6hJ0·Ab\n\nClient ID\nsynth-id'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE·3fG6·hJ0A·b')],
  ['label with colon and blank line', syn('API key:\n\nsyn·thAp·iKey·0123·4567·89ab·cd\n'), syn('synt·hApi·Key0·1234·5678·9abc·d')],
  ['bold Passwort label', syn('**Passwort**\nSo·mmer24!x\nweiter'), 'Sommer24!x'],
  ['label in a code fence', syn('Access token\n```\nZq8·xW2v·K9mP·a4rT·7yB1·nC5d·E\n```'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE')],
  ['label line in escaped json', syn('{"t":"Client secret\\nZq8·xW2v·K9mP·a4rT·7yB1·nC5d·E\\nClient ID"}'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE')],
  ['label API-Schlüssel', syn('API-Schlüssel\nZq8·xW2v·K9mP·a4rT·7yB1·nC5d·E'), syn('Zq8x·W2vK·9mPa·4rT7·yB1n·C5dE')],  // critic round 5, P0-1 (b) / P2-1: German and loose labels, label lines ending in the word, tables, YAML, vendor shapes
  ['de geheimcode hex', syn('meta geheimcode: 9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c'), syn('9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c')],
  ['de geheimcode mixed', syn('stripe geheimcode: Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['App-Geheimcode', syn('App-Geheimcode: 9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c'), syn('9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c')],
  ['Geheimcode lautet', syn('Der Geheimcode lautet Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['Geheimnis ist', syn('Das Geheimnis ist Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['geheim colon', syn('geheim: Som·mer24!x'), 'Sommer24!x'],
  ['pw ist', syn('pw ist Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['pw colon', syn('pw: Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['pw short password', syn('PW: Som·mer24!'), 'Sommer24!'],
  ['Kennwort equals', syn('Kennwort = Som·mer24!x'), 'Sommer24!x'],
  ['Meta App Secret colon', syn('Meta App Secret: 9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c'), syn('9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c')],
  ['app secret equals', syn('app_·secr·et=9·c2f4·e7a1·b3d5·f60a·8e2c·4b6d·8f01·a3c'), syn('9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c')],
  ['Zugangsdaten user slash', syn('Zugangsdaten: florian / Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['Zugangsdaten short password', 'Zugangsdaten: synth / Sommer24!', 'Sommer24!'],
  ['login user slash', syn('login: admin@example.org / Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['hier der key', syn('hier der key: Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['the key is', syn('the key is Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['key ist', syn('der key ist 9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c'), syn('9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c')],
  ['token arrow', syn('Token —> Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['token ascii arrow', syn('token -> Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['label line Meta App Secret', syn('Meta App Secret\n9c2·f4e7·a1b3·d5f6·0a8e·2c4b·6d8f·01a3·c'), syn('9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c')],
  ['label line Stripe Geheimcode', syn('Stripe Geheimcode\n\nZq7·xWv2·PLk9·mRt4·YbN8·cHs3·G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['label line geheimcode', syn('geheimcode\n9c2·f4e7·a1b3·d5f6·0a8e·2c4b·6d8f·01a3·c'), syn('9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c')],
  ['label line Zugangsdaten', 'Zugangsdaten:\nSommer24!x', 'Sommer24!x'],
  ['label line pw', syn('pw\nSo·mmer24!x'), 'Sommer24!x'],
  ['label line in escaped json', syn('{"t":"Meta App Secret\\n9c2·f4e7·a1b3·d5f6·0a8e·2c4b·6d8f·01a3·c\\nweiter"}'), syn('9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c')],
  ['md table API key column', syn('| Service | API key |\n|---|---|\n| foo | Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G |'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['md table Passwort column', syn('| Konto | Passwort | Notiz |\n| --- | --- | --- |\n| synth | `Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G` | alt |'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['md table second row', syn('| Name | Token |\n|:--|:--|\n| a | Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G |\n| b | 9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c·abcd |'), syn('9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c')],
  ['yaml folded', syn('api_key: >-\n  Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['yaml literal', syn('client_secret: |\n    Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G\nnext: 1'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['sendgrid', syn('SG.Z·q7xW·v2PL·k9mR·t4Yb·N8cH·s3G.·Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G·abcd·EFGH·12'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['google refresh', syn('1//0·gZq7·xWv2·PLk9·mRt4·YbN8·cHs3·G-Zq·7xWv·2PLk·9mRt·4YbN·8cHs·3G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['google access ya29', syn('ya29·.a0A·fZq7·xWv2·PLk9·mRt4·YbN8·cHs3·GZq7·xWv2·PLk9·mRt4·YbN8·cHs3·G'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
  ['facebook access token', syn('EAAB·Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G·Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G·ZDZD'), syn('Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G')],
];

const KEEP = [
  'COUNTRY_CODE=DE',
  'MAX_TOKENS=4000',
  'MAX_TOKENS: 4000',
  '{"author": "Florian Example", "token_type": "Bearer", "max_tokens": 4000}',
  '{"name":"Beispiel","value":"ein normaler Wert","size":3}',
  'Basic configuration steps for the workshop',
  'ask-investigate-job-20261024-long',
  '/home/flori/jobs/explainer-desk-upgrades-20261028/STATE.md',
  'Claude Code 2.1 läuft seit 2026-10-28 um 10:24',
  'Am 28.10.2026 kostete das 1234 EUR',
  'Board-Eintrag #18567 ist erledigt',
  'https://explainers.app.mintapis.com/p/demo/',
  'https://www.youtube.com/watch?v=abc&t=42',
  'Die Pipeline hat 12 Schritte und läuft auf Sandy.',
  'SESSION_COUNT is 4 in the code',
  'Kasachstan 2024 und Pakistan 2025',
  // critic round 2 KEEP list (scripts/redact2.mjs) and the new rules' near misses
  'Die Session lief 12 Minuten und hat 3 Dateien geändert.',
  'Der Token-Verbrauch lag bei 48 000 Tokens pro Lauf.',
  'Das Passwort-Feld im Login-Formular ist jetzt Pflicht.',
  'Das Passwort ist abgelaufen.',
  'Die API-Key-Rotation ist für November geplant.',
  syn('sha256 3f4a·9b0c·1d2e·3f4a·5b6c·7d8e·9f0a·1b2c·3d4e·5f6a·7b8c·9d0e·1f2a·3b4c·5d6e·7f8a'),
  'Telefon-PIN-Reset wurde besprochen, ohne Zahlen.',
  'cookie consent banner entfernt',
  '| password | string | required |',
  'Die Funktion redact(secret) maskiert Werte.',
  '{"key":"LLM-APIs","sumEur":17910,"count":200}',
  "{'keyboard': 'deutsch-QWERTZ', 'passengers': 'zweihundert'}",
  'max_tokens = 400000000',
  '{"token_type": "Bearer", "author": "Beispielautor"}',
  'https://hooks.slack.com/',
  // critic round 3, P1-3 (scripts/overredact-why.mjs): ordinary workshop text that round 3 hid
  'resolved-keys: synth-decision-alpha-31535, synth-other-key-1028',
  'keys: alpha, beta, gamma-2026',
  '{"sessionId": "01a1564b-c45e-75e2-a817-643e93aa1234", "session": "synth-demo-job"}',
  '"session": "discovery"',
  'deploy synth01x, pin 0664',
  'rollback = pin 0664',
  'gateway train on pin 9717654',
  'device #22893, code 18040',
  'older → `code 75008`',
  syn('11:31Z API gate PASSED: s1m-·supe·rvis·or'),
  syn('PASS: s1m-·supe·rvis·or'),
  'he 05:30Z timer session: discovery',
  'resume session: dispatch',
  'tokens = max(measured, granted)',
  'SET granted_tokens=granted_tokens+100000000,',
  syn('max_·num_·batc·hed_·toke·ns=m·ax_m·odel·_len·=327·68,'),
  "ots were rejected 'auth: StaleRequest'",
  'ssh -o StrictHostKeyChecking=accept-new host',
  'auth_mode=chatgpt',
  syn('GH_TOKEN=$GIT·HUB_PAT_2 from the env file'),
  'RENT_SESSION_START_UTC = Tue 27 Oct 14:30Z',
  'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus bash',
  'ROW_OUT_TOKENS=zero',
  syn('hotkey 5Fak·eSyn·thHo·tkey·Addr·0123·4567·89ab·cdef·ghij·kLMN·OPQ'),
  'coldkey = 220/223)',
  'token = synth-team-name;',
  "token = json.loads(json.loads(raw))",
  "TOKEN = open('/tmp/synth_token.txt').read().strip()",
  'decision-demos.key = internal',
  'Fuzzy pass: `basal-omni-1.1-max`',
  'the password is **not** stored',
  'export SYNTH_CLOUD_API_KEY="your-synth-key"',
  'https://github.com/synth-owner/agent-desk/pull/12',
  // critic round 4: near misses of the new rules, and doc placeholders (P2-6)
  "--password '<password>'",
  syn('tool login --password "${SYN·TH_PASSWORD}"'),
  'curl "https://tenor.example.com/v2/search?q=cat&key=${SYNTH_TENOR_API_KEY}&limit=1"',
  'https://api.example.com/v1?token=<token>',
  syn('postgres://app:${DB_PASSWORD}@db:·5432/x'),
  syn('redis://:<password>@loc·alhost:6379/0'),
  "'password' => '<password>',",
  'echo $GH_TOKEN | gh auth login --with-token',
  'docker login -u synth -p $SYNTH_REGISTRY_TOKEN ghcr.io',
  "ssh-keygen -t ed25519 -N '' -f key",
  'Authorization: Bearer $TOKEN',
  'Authorization: required for every route',
  'OPENAI_API_KEY environment_variable_name',
  'SSH_PRIVATE_KEY /home/synth/.ssh/id_ed25519',
  'fingerprint SHA256:abc',
  'the token is synth-team-name',
  'token count 4096 per request',
  'Token\nThe token is rotated weekly.',
  'Password\n<password>',
  '## Secret\n\nNo secret here',
  'Passwort\nvergessen',
  'Client secret\nsiehe Tresor',
  'MAX_TOKENS 4096',
  'price is $1$ per unit',
  // critic round 5 near misses: German prose, short or plain values, table columns that are not secrets, ids
  'Der Geheimcode steht im Tresor, nicht hier.',
  'Das Geheimnis ist gelüftet.',
  'Das Passwort für PDFMint muss morgen geändert werden.',
  'pw ist noch offen',
  'Zugangsdaten: siehe Tresor / Bitwarden',
  'login: florian / ohne',
  'Get redirected to /login?next=/settings\\n3. Log in',
  'see docs/login/setup / v2.1 notes',
  'the key is missing',
  'hier der key: siehe Tresor',
  'Token —> abgelaufen',
  'Meta App Secret\nsiehe Tresor',
  'geheimcode\n482',
  '| Modell | Preis |\n|---|---|\n| opus | 15 USD |',
  '| Key | Wert |\n|---|---|\n| region | eu-central-1 |',
  '| Token-ID | Status |\n|---|---|\n| 3360dfeb-ed6c-4ed9-9de8-893b03804a11 | aktiv |',
  syn('commit 9c2f·4e7a·1b3d·5f60·a8e2·c4b6·d8f0·1a3c·4b6d·8f01 merged'),
  'session 3360dfeb-ed6c-4ed9-9de8-893b03804a11',
  'keepalive-garantie-20261026-77f7ktj06w',
  'SGD 1200 per year',
  'EAAA is an acronym',
  // P2-8: a bare id at the start of a text, before env lines (base64 of plain text is an encoded name, not a key)
  syn('Q3l0·cHJv·ZHVj·dGlv·bjEy·MzQ1\nNODE_ENV=production'),
];

describe('redact (extended, §4)', () => {
  for (const [label, text, secret] of SECRET) {
    it(`removes ${label}`, () => {
      const out = gwRedact(text);
      assert.ok(!out.includes(secret), `${label}: ${out}`);
      assert.ok(out.includes('[REDACTED]'), `${label}: ${out}`);
      assert.ok(!short(text, 400).includes(secret), `${label} via short()`);
    });
  }
  it('keeps ordinary workshop text unchanged', () => {
    for (const text of KEEP) assert.equal(gwRedact(text), text);
  });
});

describe('gateway and bridge redact agree', () => {
  it('redactPatterns.js is byte-identical in gateway and bridge', () => {
    const gw = fs.readFileSync(new URL('../src/redactPatterns.js', import.meta.url), 'utf8');
    const br = fs.readFileSync(new URL('../../bridge/src/redactPatterns.js', import.meta.url), 'utf8');
    assert.equal(gw, br);
  });
  it('offload.js and offloadWorker.js are byte-identical in gateway and bridge (critic r7)', () => {
    for (const f of ['offload.js', 'offloadWorker.js']) {
      assert.equal(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), fs.readFileSync(new URL(`../../bridge/src/${f}`, import.meta.url), 'utf8'), f);
    }
  });
  it('both produce the same output on every case', () => {
    for (const text of [...SECRET.map((c) => c[1]), ...KEEP]) assert.equal(bridgeRedact(text), gwRedact(text), text);
  });
});

describe('redact stays linear on adversarial input (critic round 4, ReDoS)', () => {
  // 50 kB runs that made unbounded lazy key scans / prefix runs quadratic (a run of dashes took ~16 s before)
  const N = 50_000;
  const runs = ['-', '|---|---|\n', '- * # > | ', 'Client secret\n', 'token\\n', 'echo x | ', 'docker login -u x ', 'ssh-keygen -x ',
    'Authorization: ', 'SYNTH_TOKEN , ', 'token is ', 'redis://:a', "'password' => ", syn('MTA4·NzY1·NDMy·MTA5·ODc2·NTQz·Mg.'), 'code-', 'x.y-z_',
    'meta app secret ', 'geheimcode: ', 'pw ist ', 'Zugangsdaten: a / ', '| key | x |\n', 'api_key: >-\n ', 'a b c d e secret\n', 'SG.a', '1//0a'];
  for (const piece of runs) {
    it(`a ${N}-char run of ${JSON.stringify(piece)}`, () => {
      const t = piece.repeat(Math.ceil(N / piece.length)).slice(0, N);
      const s = Date.now();
      gwRedact(t);
      assert.ok(Date.now() - s < 1500, `${Date.now() - s} ms`);
    });
  }
});
