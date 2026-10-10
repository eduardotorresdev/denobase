import type { OAuthLocale } from "./types.ts";

/** Every text the user reads on /oauth/* pages. Errors sent back to the client (RFC 6749) stay in English. */
export interface Messages {
  lang: string;
  someApp: string;
  signIn: string;
  signInLead: (client: string) => string;
  email: string;
  password: string;
  emailMeCode: string;
  orCode: string;
  enterCode: string;
  checkEmail: string;
  codeSent: (email: string) => string;
  code: string;
  continue: string;
  authorizeTitle: string;
  whoAsks: string;
  whichAccount: string;
  whatItCanDo: string;
  whereUsed: string;
  permissions: string;
  /** What each built-in scope lets the app do, in this language (the app's own scopes bring their description). */
  scopeText: Record<string, string>;
  unverified: string;
  unverifiedHint: string;
  loopbackWarn: string;
  details: string;
  sendsBackTo: string;
  clientId: string;
  resource: string;
  deny: string;
  allow: string;
  notYou: () => string;
  otherAccount: string;
  notAvailable: string;
  turnedOff: string;
  unknownApp: string;
  appGone: string;
  clientIdUnknown: string;
  invalidRequest: string;
  redirectRequired: string;
  invalidRedirect: string;
  redirectNotRegistered: string;
  requestExpired: string;
  requestExpiredMsg: string;
  forbidden: string;
  crossSite: string;
  invalidForm: string;
  signedOut: string;
  sessionEnded: string;
  youSignedOut: string;
  tooManyAttempts: string;
  enterEmailPassword: string;
  invalidCredentials: string;
  tooManyCodes: string;
  enterEmail: string;
  invalidCode: string;
  allowedTitle: string;
  allowedLead: (client: string, app: string, email: string) => string;
  deniedTitle: string;
  deniedLead: (client: string, app: string) => string;
  closeTab: string;
  returning: string;
  notReacting: string;
  backToApp: string;
  revokeHint: string;
  nothingShared: string;
}

const en: Messages = {
  lang: "en",
  someApp: "An application",
  signIn: "Sign in",
  signInLead: (c) => `<strong>${c}</strong> wants to access your account. Sign in to continue.`,
  email: "Email",
  password: "Password",
  emailMeCode: "Email me a code",
  orCode: "Or sign in with a code sent by email",
  enterCode: "Enter the code",
  checkEmail: "Check your email",
  codeSent: (e) => `If <strong>${e}</strong> has an account, a code is on its way.`,
  code: "Code",
  continue: "Continue",
  authorizeTitle: "Authorize access",
  whoAsks: "Who is asking",
  whichAccount: "With which account",
  whatItCanDo: "What it will be able to do",
  whereUsed: "Where it will be used",
  permissions: "Permissions",
  scopeText: {
    mcp: "Use the MCP tools with your access rules.",
    "mcp:read": "Only read-only MCP tools (no writes).",
    "mcp:write": "Every MCP tool, limited to what you can do.",
    offline_access: "Stay connected (refresh token) while you are away.",
  },
  unverified: "Unverified",
  unverifiedHint: "This application registered itself; its name is not verified.",
  loopbackWarn: "This is an app running on your own computer. Only continue if you started it.",
  details: "Technical details",
  sendsBackTo: "Sends you back to",
  clientId: "Application id",
  resource: "Resource",
  deny: "Deny",
  allow: "Authorize",
  notYou: () => "Not you?",
  otherAccount: "Use another account",
  notAvailable: "Not available",
  turnedOff: "Authorization is turned off on this server.",
  unknownApp: "Unknown application",
  appGone: "This application is no longer registered.",
  clientIdUnknown: "The client_id is not registered here.",
  invalidRequest: "Invalid request",
  redirectRequired: "redirect_uri is required.",
  invalidRedirect: "Invalid redirect",
  redirectNotRegistered: "The redirect_uri is not registered for this application.",
  requestExpired: "Request expired",
  requestExpiredMsg: "This authorization request expired or was already used. Start again from the app.",
  forbidden: "Forbidden",
  crossSite: "Cross-site request refused.",
  invalidForm: "Invalid form token. Start again from the app.",
  signedOut: "Signed out",
  sessionEnded: "Your session ended. Start again from the app.",
  youSignedOut: "You are signed out.",
  tooManyAttempts: "Too many attempts. Wait a minute and try again.",
  enterEmailPassword: "Enter your email and password.",
  invalidCredentials: "Invalid email or password.",
  tooManyCodes: "Too many codes requested. Wait a while and try again.",
  enterEmail: "Enter your email.",
  invalidCode: "Invalid or expired code.",
  allowedTitle: "Access authorized",
  allowedLead: (c, a, e) => `<strong>${c}</strong> can now access ${a} as <strong>${e}</strong>.`,
  deniedTitle: "Access denied",
  deniedLead: (c, a) => `<strong>${c}</strong> will not access ${a}.`,
  closeTab: "You can close this tab and go back to the app.",
  returning: "Taking you back to the app…",
  notReacting: "App did not react?",
  backToApp: "Go back to the app",
  revokeHint: "You can revoke this access at any time.",
  nothingShared: "Nothing was shared with the app.",
};

const ptBR: Messages = {
  lang: "pt-BR",
  someApp: "Um aplicativo",
  signIn: "Entrar",
  signInLead: (c) => `<strong>${c}</strong> quer acessar sua conta. Entre para continuar.`,
  email: "E-mail",
  password: "Senha",
  emailMeCode: "Receber código por e-mail",
  orCode: "Ou entre com um código enviado por e-mail",
  enterCode: "Digite o código",
  checkEmail: "Confira seu e-mail",
  codeSent: (e) => `Se <strong>${e}</strong> tiver conta, um código está a caminho.`,
  code: "Código",
  continue: "Continuar",
  authorizeTitle: "Autorizar acesso",
  whoAsks: "Quem está pedindo",
  whichAccount: "Com qual conta",
  whatItCanDo: "O que poderá fazer",
  whereUsed: "Onde será usado",
  permissions: "Permissões",
  scopeText: {
    mcp: "Usar as ferramentas MCP respeitando as suas permissões",
    "mcp:read": "Só ferramentas de leitura, sem alterar nada",
    "mcp:write": "Todas as ferramentas MCP, limitadas ao que você pode fazer",
    offline_access: "Continuar conectado mesmo quando você não estiver usando",
  },
  unverified: "Não verificado",
  unverifiedHint: "Este aplicativo se cadastrou sozinho; o nome dele não foi verificado.",
  loopbackWarn: "É um aplicativo rodando no seu próprio computador. Só continue se foi você que o abriu.",
  details: "Detalhes técnicos",
  sendsBackTo: "Volta para",
  clientId: "Id do aplicativo",
  resource: "Recurso",
  deny: "Recusar",
  allow: "Autorizar",
  notYou: () => "Não é você?",
  otherAccount: "Usar outra conta",
  notAvailable: "Indisponível",
  turnedOff: "A autorização está desligada neste servidor.",
  unknownApp: "Aplicativo desconhecido",
  appGone: "Este aplicativo não está mais cadastrado.",
  clientIdUnknown: "O identificador do aplicativo não está cadastrado aqui.",
  invalidRequest: "Pedido inválido",
  redirectRequired: "O endereço de retorno é obrigatório.",
  invalidRedirect: "Retorno inválido",
  redirectNotRegistered: "O endereço de retorno não está cadastrado para este aplicativo.",
  requestExpired: "Pedido expirado",
  requestExpiredMsg: "Este pedido de autorização expirou ou já foi usado. Comece de novo pelo aplicativo.",
  forbidden: "Proibido",
  crossSite: "Pedido de outro site recusado.",
  invalidForm: "Formulário inválido. Comece de novo pelo aplicativo.",
  signedOut: "Sessão encerrada",
  sessionEnded: "Sua sessão acabou. Comece de novo pelo aplicativo.",
  youSignedOut: "Você saiu.",
  tooManyAttempts: "Muitas tentativas. Espere um minuto e tente de novo.",
  enterEmailPassword: "Informe e-mail e senha.",
  invalidCredentials: "E-mail ou senha inválidos.",
  tooManyCodes: "Muitos códigos pedidos. Espere um pouco e tente de novo.",
  enterEmail: "Informe seu e-mail.",
  invalidCode: "Código inválido ou expirado.",
  allowedTitle: "Acesso autorizado",
  allowedLead: (c, a, e) => `<strong>${c}</strong> já pode acessar ${a} como <strong>${e}</strong>.`,
  deniedTitle: "Acesso recusado",
  deniedLead: (c, a) => `<strong>${c}</strong> não vai acessar ${a}.`,
  closeTab: "Você pode fechar esta aba e voltar para o aplicativo.",
  returning: "Voltando para o aplicativo…",
  notReacting: "O aplicativo não reagiu?",
  backToApp: "Clique aqui para voltar",
  revokeHint: "Você pode revogar este acesso quando quiser.",
  nothingShared: "Nada foi compartilhado com o aplicativo.",
};

const ALL: Record<OAuthLocale, Messages> = { en, "pt-BR": ptBR };

export function messages(locale: OAuthLocale | undefined): Messages {
  return ALL[locale ?? "en"] ?? en;
}
