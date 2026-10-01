# Customer Service Platform

A platform for businesses to configure AI agents, workflows, and knowledge sources for personalized customer service.

## Language

**Operator**:
A person who configures the platform or provides customer support for a business.
_Avoid_: User when referring to the person configuring the platform.

**Business**:
An organization whose customer service, knowledge, and customer memory are kept separate from other businesses.

**Membership**:
An operator's role and access within one business. An operator can have separate memberships in multiple businesses.

**Owner**:
An operator role with full access within a business, including settings, credentials, and the developer view.

**Support**:
An operator role with access to a business's inbox and customer memory.

**Verified customer identity**:
A stable customer identity authenticated by a business's website and recognized only within that business.

**Anonymous conversation**:
A browser-scoped conversation without a verified customer identity. Only the current anonymous conversation can join a customer's history after verified login.

**Customer**:
A person who chats with a business's agent for service.
_Avoid_: User when referring to the person receiving service.

**Conversation history**:
The stored record of messages exchanged during customer conversations.

**Customer memory**:
Explicitly stated service preferences retained with customer consent across conversations to personalize service. Customer memory is distinct from conversation history.
_Avoid_: Session memory, user memory.

**Knowledge source**:
A business-owned document or scoped website supplying stored evidence for customer-service answers.

**Source version**:
A complete, successfully ingested snapshot of a knowledge source.

**Live business data**:
Current business information returned by an authorized API action, distinct from stored knowledge.

**Human takeover**:
A conversation under human control, with automated execution, replies, and customer-memory extraction paused until explicitly returned to automation.

**Support queue**:
A business's shared collection of conversations awaiting an operator's claim.

**Conversation assignee**:
The single operator responsible for a conversation and permitted to send replies, resolve it, or return it to automation.

**Agent/workflow configuration**:
A business's editable definition of its agents, allowed actions, and workflow behavior, represented by both the visual builder and developer view.

**Configuration draft**:
Unpublished edits to an agent/workflow configuration. Invalid edits remain part of the draft until corrected or explicitly discarded.

**Execution trace**:
A read-only record of a conversation's automated steps and results, tied to its configuration version and with sensitive values redacted.
