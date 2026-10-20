import { createRoot } from "react-dom/client";
import "./styles/base.css";
import "./features/updates/updates.css";
import "./styles/base-elements.css";
import "./features/transcript/file-links.css";
import "./features/sidebar/shell.css";
import "./features/sidebar/navigation.css";
import "./styles/app-layout.css";
import "./features/header/header.css";
import "./features/menus/session-menu.css";
import "./features/sidebar/resizer.css";
import "./features/menus/session-menu-items.css";
import "./features/header/status.css";
import "./features/transcript/conversation.css";
import "./styles/base-controls.css";
import "./features/transcript/messages.css";
import "./features/transcript/changed-files.css";
import "./features/menus/file-menu.css";
import "./features/transcript/message-content.css";
import "./features/composer/composer.css";
import "./features/composer/pickers.css";
import "./features/composer/send.css";
import "./features/composer/usage-footer.css";
import "./features/composer/queue.css";
import "./features/transcript/jump.css";
import "./styles/error-banner.css";
import "./features/workspace/details-panel.css";
import "./features/workspace/terminal-pane.css";
import "./styles/base-utilities.css";
import "./features/transcript/notices.css";
import "./features/dialogs/dialogs.css";
import "./styles/responsive.css";
import "./features/composer/attachments.css";
import "./features/dialogs/attachment-lightbox.css";
import "./features/composer/attachments-responsive.css";
import "./features/sidebar/project-icon.css";
import "./features/dialogs/settings-tree.css";
import "./features/sidebar/session-icons.css";
import "./features/transcript/images.css";
import "./features/catalog/catalog.css";
import "./features/sidebar/sections.css";
import "./features/directory/directory-dialog.css";
import "./features/menus/project-menu.css";
import "./features/file-preview/linked-file.css";
import "./features/composer/picker-arrow.css";
import "./features/sidebar/drag-activity.css";
import { AppBoundary } from "./app/app-boundary.js";
import { App } from "./app/App.js";

createRoot(document.getElementById("root")!).render(
  <AppBoundary>
    <App />
  </AppBoundary>,
);
