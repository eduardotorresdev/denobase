import "./pb.js";
import "./store.js";
import { layout } from "./layout.js";
import { initRouter } from "./router.js";

app.store.authEmail = app.pb.authStore.record?.email || "";
app.pb.authStore.onChange(() => {
  app.store.authEmail = app.pb.authStore.record?.email || "";
});

document.body.prepend(layout());
initRouter();
