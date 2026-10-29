import Ajv from 'ajv';

const nullable = type => ({type: [type, 'null']});
export const invoiceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    invoice_number: nullable('string'), invoice_date: nullable('string'),
    supplier_name: nullable('string'), customer_name: nullable('string'),
    subtotal: nullable('number'), tax: nullable('number'), total: nullable('number'),
    currency: nullable('string'),
    line_items: {type: 'array', maxItems: 5000, items: {
      type: 'object', additionalProperties: false,
      properties: {description: {type: 'string'}, quantity: nullable('number'), unit_price: nullable('number'), line_total: nullable('number')},
      required: ['description', 'quantity', 'unit_price', 'line_total']
    }},
    extraction_confidence: {type: 'number', minimum: 0, maximum: 1}
  },
  required: ['invoice_number','invoice_date','supplier_name','customer_name','subtotal','tax','total','currency','line_items','extraction_confidence']
};
const ajv = new Ajv({allErrors: true});
export const validateInvoice = ajv.compile(invoiceSchema);
export const validatePatch = ajv.compile({...invoiceSchema, required: [], minProperties: 1});
export const emptyInvoice = () => ({invoice_number:null, invoice_date:null, supplier_name:null, customer_name:null, subtotal:null, tax:null, total:null, currency:null, line_items:[], extraction_confidence:0});
