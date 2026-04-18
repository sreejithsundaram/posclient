export interface CartItem {
  lineId?:  number;
  billId?:  number;
  slNo:     number;   // UI only
  id:       number;   // productid
  item:     string;
  qty:      number;
  mrp:      number;
  sp:       number;
  savings:  number;
  total:    number;
  image?:   string;
}

export interface ProductResult {
  id:     number;
  name:   string;
  mrp:    number;
  sp:     number;
  stock:  number;
  image?: string;
}

export interface BilllineView {
  id:          number;
  billid:      number;
  productid:   number;
  productname: string;
  qty:         number;
  mrp:         number;
  sp:          number;
  savings:     number;
  total:       number;
}

export interface BillView {
  id:           number | null;
  number:       string | null;
  customer:     string | null;
  state:        number;
  subtotal:     number;
  savings:      number;
  roundedtotal: number;
  billlines:    BilllineView[];
}
