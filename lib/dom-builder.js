"use strict";

// Minimal element factory for the frontend. Everything goes through
// createElement/setAttribute/createTextNode - never innerHTML - so values from
// the Home Connect API (appliance names, program names, error texts) are
// always rendered as text and can never inject markup.
//
// Loaded in the browser via getScripts() (exposed as window.HomeConnectDomBuilder)
// and required directly by the renderers and tests in Node.
(() => {
  function appendChildren(parent, children) {
    const list = Array.isArray(children) ? children : [children];
    list.forEach((child) => {
      if (child === null || child === undefined || child === false || child === "") {
        return;
      }
      if (Array.isArray(child)) {
        appendChildren(parent, child);
        return;
      }
      if (typeof child === "string" || typeof child === "number") {
        parent.appendChild(document.createTextNode(String(child)));
        return;
      }
      parent.appendChild(child);
    });
  }

  // h("div", { class: "x", title: "y" }, ["text", h("span", null, "child")])
  // Attributes with null/undefined/false values are skipped; strings and numbers
  // among the children become text nodes.
  function h(tag, attributes, children) {
    const element = document.createElement(tag);
    Object.entries(attributes || {}).forEach(([name, value]) => {
      if (value === null || value === undefined || value === false) {
        return;
      }
      element.setAttribute(name, String(value));
    });
    appendChildren(element, children);
    return element;
  }

  // Links come from the OAuth server; only http(s) targets are rendered as links.
  function isSafeHttpUrl(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value.trim());
  }

  const exportsObj = { h, isSafeHttpUrl };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exportsObj;
  }

  if (typeof window !== "undefined") {
    window.HomeConnectDomBuilder = exportsObj;
  }
})();
