import { createInMemoryNotificationStore } from "./notification-store.js";
import { describeNotificationStore } from "./notification-store.suite.js";

describeNotificationStore("in memory", () => createInMemoryNotificationStore());
