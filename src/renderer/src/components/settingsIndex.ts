import type { SettingDef } from '@shared/settingsSearch';

/**
 * Every setting the Settings modal shows, in on-screen order, for its search.
 *
 * `label`/`desc`/`extra` are the i18n keys the row actually renders, so the
 * search speaks whatever language the UI is in. `keywords` are synonyms people
 * type that the visible text does not contain (English, plus Spanish where the
 * Spanish label words it differently). `anchor` names
 * the `data-setting-id` block to scroll to when the row has none of its own
 * (settings that live inside a child component).
 *
 * Adding a setting to the modal: add it here too, with a `data-setting-id` on
 * its row. test/settings-search.test.cjs checks every key exists in en and es.
 */
export const SETTINGS_INDEX: readonly SettingDef[] = [
  // ── Sections themselves: a search for the tab still finds the tab. ──
  { id: 'section:General', section: 'General', label: 'settings.nav.general', desc: 'settings.navDesc.general', extra: ['settings.find.general'], isSection: true },
  { id: 'section:Prerequisites', section: 'Prerequisites', label: 'settings.nav.prerequisites', desc: 'settings.navDesc.prerequisites', extra: ['settings.find.prerequisites'], isSection: true },
  { id: 'section:Agents & Models', section: 'Agents & Models', label: 'settings.nav.agentsModels', desc: 'settings.navDesc.agentsModels', extra: ['settings.find.agentsModels'], isSection: true },
  { id: 'section:Autonomy & Budgets', section: 'Autonomy & Budgets', label: 'settings.nav.autonomyBudgets', desc: 'settings.navDesc.autonomyBudgets', extra: ['settings.find.autonomyBudgets'], isSection: true },
  { id: 'section:Connections', section: 'Connections', label: 'settings.nav.connections', desc: 'settings.navDesc.connections', extra: ['settings.find.connections'], isSection: true },
  { id: 'section:Voice', section: 'Voice', label: 'settings.nav.voice', desc: 'settings.navDesc.voice', extra: ['settings.find.voice'], isSection: true },
  { id: 'section:Memory & Knowledge', section: 'Memory & Knowledge', label: 'settings.nav.memoryKnowledge', desc: 'settings.navDesc.memoryKnowledge', extra: ['settings.find.memoryKnowledge'], isSection: true },

  // ── General ──
  { id: 'updates', section: 'General', label: 'updatesSection.title', keywords: 'update version upgrade release download new' },
  { id: 'freezes', section: 'General', label: 'settings.freezes.title', desc: 'settings.freezes.hint', keywords: 'freeze hang stall frozen slow log' },
  { id: 'officeRender', section: 'General', label: 'settings.officeRender.title', extra: ['settings.officeRender.fullDesc', 'settings.officeRender.stillDesc', 'settings.officeRender.cardsDesc'], keywords: 'performance render floor walking cards gpu battery' },
  { id: 'homeFolder', section: 'General', label: 'settings.general.homeFolder', keywords: 'folder directory path home data location move' },
  { id: 'keepAwake', section: 'General', label: 'settings.general.keepAwake', desc: 'settings.general.keepAwakeDesc', extra: ['settings.general.environment'], keywords: 'sleep awake power battery suspender dormir' },
  { id: 'simpleMode', section: 'General', label: 'settings.general.simpleMode', desc: 'settings.general.simpleModeDesc', keywords: 'simple mode plain language non-technical audience modo sencillo' },
  { id: 'language', section: 'General', label: 'settings.general.language', desc: 'settings.general.languageDesc', keywords: 'language idioma english spanish espanol locale' },
  { id: 'notifications', section: 'General', label: 'settings.general.desktopNotifications', desc: 'settings.general.desktopNotificationsDesc', extra: ['settings.general.notifications'], keywords: 'notifications alerts toast avisos alertas' },
  { id: 'autoCompact', section: 'General', label: 'settings.general.autoCompact', desc: 'settings.general.autoCompactDesc', extra: ['settings.general.maintenance'], keywords: 'compact context schedule compactar contexto' },
  { id: 'autoUpdate', section: 'General', label: 'settings.general.autoUpdate', desc: 'settings.general.autoUpdateDesc', keywords: 'update automatic' },
  { id: 'officeTheme', section: 'General', label: 'officeTheme.title', desc: 'officeTheme.desc', keywords: 'theme office map tv show' },
  { id: 'reset', section: 'General', label: 'settings.general.dangerZone', extra: ['settings.general.resetStartOver'], keywords: 'reset erase wipe delete start over danger reiniciar borrar' },

  // ── Prerequisites ── (SetupPanel is one block; the tab entry above covers its words)

  // ── Agents & Models ──
  { id: 'defaultModel', section: 'Agents & Models', label: 'settings.agentsModels.defaultModel', desc: 'settings.agentsModels.defaultModelDesc', keywords: 'model default opus sonnet haiku' },
  { id: 'roleModels', section: 'Agents & Models', label: 'settings.agentsModels.perRole', desc: 'settings.agentsModels.perRoleDesc', extra: ['settings.agentsModels.roleModel', 'settings.agentsModels.roleEffort'], keywords: 'role model effort reasoning' },
  { id: 'providers', section: 'Agents & Models', anchor: 'aiEngines', label: 'aiEngines.providers', desc: 'aiEngines.providersDesc', keywords: 'provider engine byok openai openrouter anthropic' },
  { id: 'apiKeys', section: 'Agents & Models', anchor: 'aiEngines', label: 'aiEngines.apiKeys', keywords: 'api key token secret' },
  { id: 'certs', section: 'Agents & Models', anchor: 'aiEngines', label: 'aiEngines.certs', desc: 'aiEngines.certsDesc', keywords: 'certificate tls ssl ca proxy https' },
  { id: 'pi', section: 'Agents & Models', anchor: 'aiEngines', label: 'aiEngines.piTitle', keywords: 'pi sandbox hosts' },
  { id: 'maxTurns', section: 'Agents & Models', label: 'settings.agentsModels.maxTurns', desc: 'settings.agentsModels.blankUnlimited', extra: ['settings.agentsModels.advanced'], keywords: 'turns limit advanced' },

  // ── Autonomy & Budgets ──
  { id: 'autoMode', section: 'Autonomy & Budgets', label: 'settings.autonomy.autonomy', desc: 'settings.autonomy.autoDesc', extra: ['settings.autonomy.autoOn', 'settings.autonomy.autoOff'], keywords: 'auto mode approve permission ask autonomous' },
  { id: 'whoCanAdd', section: 'Autonomy & Budgets', label: 'settings.autonomy.whoCanAdd', keywords: 'hire spawn add agents orchestrator' },
  { id: 'temps', section: 'Autonomy & Budgets', label: 'tempQuota.title', desc: 'tempQuota.desc', keywords: 'temps temporary workers quota' },
  { id: 'breaker', section: 'Autonomy & Budgets', label: 'settings.autonomy.breaker', desc: 'settings.autonomy.breakerDesc', keywords: 'circuit breaker runaway loop' },
  { id: 'floorBudget', section: 'Autonomy & Budgets', label: 'settings.autonomy.floorBudget', desc: 'settings.autonomy.budgetTotal', keywords: 'budget tokens cap cost spend limit presupuesto gasto coste' },
  { id: 'velocity', section: 'Autonomy & Budgets', label: 'settings.autonomy.velocity', keywords: 'velocity tokens per minute speed' },
  { id: 'repeatedLimit', section: 'Autonomy & Budgets', label: 'settings.autonomy.repeatedLimit', keywords: 'repeated tool loop limit' },
  { id: 'errorStormLimit', section: 'Autonomy & Budgets', label: 'settings.autonomy.errorStormLimit', keywords: 'error storm limit' },
  { id: 'hardStop', section: 'Autonomy & Budgets', label: 'settings.autonomy.hardStop', desc: 'settings.autonomy.hardStopDesc', keywords: 'kill stop hard' },
  { id: 'usageWindows', section: 'Autonomy & Budgets', label: 'settings.autonomy.usageWindows', desc: 'settings.autonomy.usageWindowsDesc', extra: ['settings.autonomy.fiveHourThreshold', 'settings.autonomy.weeklyThreshold'], keywords: 'usage subscription window weekly limit plan' },

  // ── Memory & Knowledge ──
  { id: 'semanticMemory', section: 'Memory & Knowledge', label: 'settings.memory.crossSession', desc: 'settings.memory.crossSessionDesc', extra: ['settings.memory.semanticMemory'], keywords: 'memory semantic mempalace embedding model' },
  { id: 'knowledgeGraph', section: 'Memory & Knowledge', label: 'settings.memory.kgTitle', desc: 'settings.memory.kgDesc', extra: ['settings.memory.kg', 'settings.memory.addFiles'], keywords: 'knowledge graph documents files' },

  // ── Connections ──
  { id: 'mcpDefaults', section: 'Connections', label: 'mcpDefaults.title', desc: 'mcpDefaults.desc', keywords: 'mcp server tools' },
  { id: 'integrations', section: 'Connections', label: 'integrations.title', desc: 'integrations.titleDesc', keywords: 'integrations services jira github connect' },
  { id: 'slack', section: 'Connections', label: 'settings.connections.slackIntegration', extra: ['settings.connections.slack', 'settings.connections.signingSecret', 'settings.connections.botToken', 'settings.connections.channelId', 'settings.connections.port', 'tempAnswer.whoAnswers', 'settings.connections.proactivePosting'], keywords: 'slack bot token channel' },
  { id: 'webhooks', section: 'Connections', label: 'settings.connections.webhooks', desc: 'settings.connections.webhooksDesc', keywords: 'webhook trigger http endpoint secret' },
  { id: 'organisation', section: 'Connections', label: 'settings.connections.orgKey', desc: 'settings.connections.orgKeyDesc', extra: ['settings.connections.organisation'], keywords: 'organisation organization team key' },

  // ── Voice ──
  { id: 'freeFlow', section: 'Voice', label: 'settings.voice.freeFlowTitle', desc: 'settings.voice.freeFlowDesc', extra: ['settings.voice.freeFlow', 'settings.voice.engine', 'settings.voice.groqKey', 'settings.voice.model'], keywords: 'dictation whisper groq offline microphone speech' },
  { id: 'realtime', section: 'Voice', label: 'settings.voice.realtime', desc: 'settings.voice.voiceChatDesc', extra: ['settings.voice.voiceChat', 'settings.voice.openaiKey', 'devicePicker.microphone', 'devicePicker.speaker'], keywords: 'realtime talk openai key microphone speaker' },
  { id: 'idleDisconnect', section: 'Voice', label: 'settings.voice.idleDisconnect', desc: 'settings.voice.idleDisconnectDesc', keywords: 'idle disconnect timeout' }
];
