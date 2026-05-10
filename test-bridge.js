async function main() {
  const req = {
    model: "gemini-3.1-pro-preview",
    messages: [
      { role: "user", content: "Check the weather in Paris and London." },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call.get_current_temperature.c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I.1",
            type: "function",
            function: { name: "get_current_temperature", arguments: "{\"location\":\"Paris\"}" }
          },
          {
            id: "call.get_current_temperature..2",
            type: "function",
            function: { name: "get_current_temperature", arguments: "{\"location\":\"London\"}" }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: "call.get_current_temperature.c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I.1",
        name: "get_current_temperature",
        content: "{\"temp\":\"15C\"}"
      },
      {
        role: "tool",
        tool_call_id: "call.get_current_temperature..2",
        name: "get_current_temperature",
        content: "{\"temp\":\"12C\"}"
      }
    ]
  };

  const res = await fetch('http://127.0.0.1:9000/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req)
  });

  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Response:", text);
}

main().catch(console.error);