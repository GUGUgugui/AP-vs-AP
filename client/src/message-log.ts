export function uniqueMessages<T extends { id: string }>(messages: T[]): T[] {
  return [...new Map(messages.map(message => [message.id, message])).values()]
}
export function appendMessage<T extends { id: string }>(messages: T[], incoming: T): T[] {
  return messages.some(message => message.id === incoming.id) ? messages : [...messages, incoming]
}
