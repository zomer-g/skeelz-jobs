// No email provider is connected, so nothing leaves the server, whatever
// SEND_EMAIL_ENABLED says. Connecting a provider needs the owner's approval and an
// update to the privacy texts (who receives data) — see CLAUDE.md.
export const sendEmail = async (
  to: string,
  subject: string,
  text: string,
  _isRtl: boolean = true
): Promise<void> => {
  // The text can hold personal details and reset links: print it only in local development.
  if (process.env.NODE_ENV !== 'production') {
    console.info("[email not sent: no provider] to=%s subject=%s\n%s", to, subject, text);
  } else {
    console.info("[email not sent: no provider] subject=%s", subject);
  }
};
