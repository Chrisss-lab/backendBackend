import { Injectable } from "@nestjs/common";

@Injectable()
export class GoogleService {
  connectState() {
    return {
      calendarEnabled: Boolean(process.env.GOOGLE_CALENDAR_ID),
      gmailEnabled: Boolean(process.env.GMAIL_SENDER_EMAIL),
      status: "Phase 2 stubs ready for OAuth and queue wiring."
    };
  }
}
