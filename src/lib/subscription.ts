export type SubscriptionProviderKey =
  | "buttondown"
  | "beehiiv"
  | "convertkit";

export type SubscriptionProvider = {
  key: SubscriptionProviderKey;
  label: string;
  description: string;
  action: string;
  method: "post" | "get";
  emailField: string;
  hiddenFields?: Record<string, string>;
  enabled: boolean;
};

export function getSubscriptionProviders(): SubscriptionProvider[] {
  const buttondownUsername = import.meta.env.PUBLIC_BUTTONDOWN_USERNAME ?? "sporadik";
  const buttondownAction =
    import.meta.env.PUBLIC_BUTTONDOWN_ACTION ??
    (buttondownUsername
      ? `https://buttondown.com/api/emails/embed-subscribe/${buttondownUsername}`
      : "");
  const beehiivAction = import.meta.env.PUBLIC_BEEHIIV_ACTION ?? "";
  const convertKitAction = import.meta.env.PUBLIC_CONVERTKIT_ACTION ?? "";

  return [
    {
      key: "buttondown",
      label: "Buttondown",
      description: "Simple writer-friendly hosted email subscriptions.",
      action: buttondownAction,
      method: "post",
      emailField: "email",
      hiddenFields: {
        embed: "1"
      },
      enabled: Boolean(buttondownAction)
    },
    {
      key: "beehiiv",
      label: "Beehiiv",
      description: "Newsletter-first hosted signup endpoint.",
      action: beehiivAction,
      method: "post",
      emailField: "email",
      enabled: Boolean(beehiivAction)
    },
    {
      key: "convertkit",
      label: "ConvertKit",
      description: "Creator-focused email list provider.",
      action: convertKitAction,
      method: "post",
      emailField: "email_address",
      enabled: Boolean(convertKitAction)
    }
  ];
}
