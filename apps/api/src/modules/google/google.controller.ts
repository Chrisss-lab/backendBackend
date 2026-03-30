import { Controller, Get } from "@nestjs/common";
import { GoogleService } from "./google.service";

@Controller("integrations/google")
export class GoogleController {
  constructor(private readonly google: GoogleService) {}

  @Get("status")
  status() {
    return this.google.connectState();
  }
}
