const part = {
  functionCall: { name: "foo", args: {} }
};
part.thought = true;
part.thoughtSignature = "skip_thought_signature_validator";
const parts = [];
parts.push(part);
console.log(JSON.stringify(parts, null, 2));
