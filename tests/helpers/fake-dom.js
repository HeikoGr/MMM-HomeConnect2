"use strict";

// Just enough DOM for the frontend renderers: createElement, createTextNode,
// setAttribute and appendChild. `innerHTML` is a read-only serialization (text
// and attribute values escaped the way a browser serializes them), so tests
// can keep asserting on the rendered markup. Assigning innerHTML throws - the
// frontend must build its DOM without parsing markup.

const VOID_ELEMENTS = new Set(["br", "img", "input", "hr", "meta", "link"]);

const escapeText = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

class FakeTextNode {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
  }

  get outerHTML() {
    return escapeText(this.textContent);
  }
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = String(tagName).toLowerCase();
    this.attributes = new Map();
    this.childNodes = [];
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  get className() {
    return this.getAttribute("class") || "";
  }

  get classList() {
    const classes = this.className.split(/\s+/).filter(Boolean);
    return { contains: (name) => classes.includes(name) };
  }

  appendChild(child) {
    if (!(child instanceof FakeElement) && !(child instanceof FakeTextNode)) {
      throw new TypeError(`appendChild expects a node, got ${typeof child}`);
    }
    this.childNodes.push(child);
    return child;
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof FakeElement);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  set textContent(value) {
    this.childNodes = [new FakeTextNode(value)];
  }

  get innerHTML() {
    return this.childNodes.map((node) => node.outerHTML).join("");
  }

  set innerHTML(_value) {
    throw new Error("innerHTML assignment is not allowed - build DOM nodes instead");
  }

  get outerHTML() {
    const attributes = [...this.attributes]
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join("");
    if (VOID_ELEMENTS.has(this.tagName)) {
      return `<${this.tagName}${attributes}>`;
    }
    return `<${this.tagName}${attributes}>${this.innerHTML}</${this.tagName}>`;
  }

  // Depth-first search over descendant elements.
  findAll(predicate) {
    const matches = [];
    const visit = (element) => {
      element.children.forEach((child) => {
        if (predicate(child)) {
          matches.push(child);
        }
        visit(child);
      });
    };
    visit(this);
    return matches;
  }

  findByClass(className) {
    return this.findAll((element) => element.classList.contains(className));
  }
}

function createFakeDocument() {
  return {
    documentElement: { lang: "en" },
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => new FakeTextNode(text)
  };
}

module.exports = { createFakeDocument, FakeElement };
