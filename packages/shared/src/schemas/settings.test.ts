import { describe, expect, it } from "vitest";
import { mergeOnlineIconSourceSettings } from "../online-icon-sources";
import { createDefaultAppSettings } from "../settings-defaults";
import { appSettingsSchema, settingsUpdateBodySchema } from "./settings";

describe("settings schema", () => {
  it("uses Frankfurter as the default exchange-rate provider", () => {
    const defaults = createDefaultAppSettings();
    expect(defaults.exchangeRateProvider).toBe("frankfurter");
    expect(settingsUpdateBodySchema.parse({ exchangeRateProvider: "frankfurter" }).exchangeRateProvider).toBe("frankfurter");
    expect(settingsUpdateBodySchema.parse({ exchangeRateProvider: "floatrates" }).exchangeRateProvider).toBe("floatrates");
    expect(settingsUpdateBodySchema.parse({ exchangeRateProvider: "exchange-api" }).exchangeRateProvider).toBe("exchange-api");
    expect(settingsUpdateBodySchema.parse({ exchangeRateProvider: "unknown" }).exchangeRateProvider).toBe("frankfurter");
  });

  it("accepts online App icon source settings with App Store enabled by default", () => {
    const defaults = createDefaultAppSettings();
    expect(defaults.onlineIconSources.appStore.enabled).toBe(true);
    expect(defaults.onlineIconSources.appStore.storefronts).toEqual(["us"]);

    expect(settingsUpdateBodySchema.parse({
      onlineIconSources: {
        appStore: { enabled: false },
      },
    }).onlineIconSources).toEqual({
      appStore: { enabled: false },
    });
    expect(settingsUpdateBodySchema.parse({
      onlineIconSources: {
        appStore: { storefronts: ["cn"] },
      },
    }).onlineIconSources).toEqual({
      appStore: { storefronts: ["cn"] },
    });
    expect(settingsUpdateBodySchema.parse({
      onlineIconSources: {
        appStore: { storefronts: ["cn", "us"] },
      },
    }).onlineIconSources).toEqual({
      appStore: { storefronts: ["us", "cn"] },
    });
    expect(settingsUpdateBodySchema.parse({
      onlineIconSources: {
        appStore: {},
      },
    }).onlineIconSources).toEqual({
      appStore: {},
    });
    expect(settingsUpdateBodySchema.safeParse({
      onlineIconSources: {
        appStore: { enabled: true, variantsEnabled: true },
      },
    }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({
      onlineIconSources: {
        appStore: { storefronts: [] },
      },
    }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({
      onlineIconSources: {
        appStore: { storefronts: ["us", "us"] },
      },
    }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({
      onlineIconSources: {
        appStore: { storefronts: ["jp"] },
      },
    }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({
      onlineIconSources: {
        googlePlay: { enabled: true },
      },
    }).success).toBe(false);

    expect(mergeOnlineIconSourceSettings({
      appStore: { enabled: true, storefronts: ["cn"] },
    }, {
      appStore: { enabled: false },
    }).appStore).toEqual({ enabled: false, storefronts: ["cn"] });
  });

  it("supports only plain or html Telegram message formats", () => {
    expect(createDefaultAppSettings().telegramMessageFormat).toBe("plain");
    expect(appSettingsSchema.pick({ telegramMessageFormat: true }).parse({ telegramMessageFormat: "plain" }).telegramMessageFormat).toBe("plain");
    expect(appSettingsSchema.pick({ telegramMessageFormat: true }).parse({ telegramMessageFormat: "html" }).telegramMessageFormat).toBe("html");
    expect(appSettingsSchema.pick({ telegramMessageFormat: true }).safeParse({ telegramMessageFormat: "markdown" }).success).toBe(false);
  });

  it("accepts Discord and PushPlus settings while keeping URLs HTTPS-only", () => {
    const defaults = createDefaultAppSettings();
    expect(defaults.discordWebhookUrl).toBe("");
    expect(defaults.discordBotUsername).toBe("");
    expect(defaults.discordBotAvatarUrl).toBe("");
    expect(defaults.pushplusToken).toBe("");

    const parsed = settingsUpdateBodySchema.parse({
      enabledChannels: ["discord", "pushplus"],
      discordWebhookUrl: "https://discord.com/api/webhooks/123/token",
      discordBotUsername: "Renewlet",
      discordBotAvatarUrl: "https://cdn.example.com/avatar.png",
      pushplusToken: "pushplus-token",
    });

    expect(parsed.enabledChannels).toEqual(["discord", "pushplus"]);
    expect(parsed.discordBotUsername).toBe("Renewlet");
    expect(settingsUpdateBodySchema.safeParse({ discordWebhookUrl: "http://discord.com/api/webhooks/123/token" }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ discordBotAvatarUrl: "http://cdn.example.com/avatar.png" }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ pushplusToken: "x".repeat(257) }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ pushplusToken: "pushplus-token", pushplusSecret: "unexpected" }).success).toBe(false);
  });

  it("accepts DingTalk settings with HTTPS webhook and markdown default", () => {
    const defaults = createDefaultAppSettings();
    expect(defaults.enabledChannels).toEqual([]);
    expect(defaults.dingtalkWebhookUrl).toBe("");
    expect(defaults.dingtalkSecret).toBe("");
    expect(defaults.dingtalkKeyword).toBe("");
    expect(defaults.dingtalkMessageType).toBe("markdown");
    expect(defaults.dingtalkTitleTemplate).toBe("");
    expect(defaults.dingtalkContentTemplate).toBe("");

    const parsed = settingsUpdateBodySchema.parse({
      enabledChannels: ["dingtalk"],
      dingtalkWebhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=token",
      dingtalkSecret: "SECabcdef",
      dingtalkKeyword: "Renewlet",
      dingtalkMessageType: "text",
      dingtalkTitleTemplate: "{brand} - {title}",
      dingtalkContentTemplate: "{keyword}\n{content}\n{timestamp}",
    });

    expect(parsed.enabledChannels).toEqual(["dingtalk"]);
    expect(parsed.dingtalkMessageType).toBe("text");
    expect(parsed.dingtalkTitleTemplate).toBe("{brand} - {title}");
    expect(parsed.dingtalkContentTemplate).toBe("{keyword}\n{content}\n{timestamp}");
    expect(settingsUpdateBodySchema.safeParse({ dingtalkTitleTemplate: "💡".repeat(500) }).success).toBe(true);
    expect(settingsUpdateBodySchema.safeParse({ dingtalkWebhookUrl: "http://oapi.dingtalk.com/robot/send?access_token=token" }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ dingtalkMessageType: "actionCard" }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ dingtalkKeyword: "x".repeat(101) }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ dingtalkTitleTemplate: "x".repeat(501) }).success).toBe(false);
    expect(settingsUpdateBodySchema.safeParse({ dingtalkContentTemplate: "x".repeat(20_001) }).success).toBe(false);
  });
});
