"""Conservative numeric compatibility, not endpoint/population attribution.

No implicit tolerance: exact values stay exact. Explicit approximate integers
use their written rounding precision, capped at two significant digits. 'Nearly'
and 'almost' additionally require the source value to be below the claim.
"""
import re
import unicodedata
from decimal import Decimal, ROUND_HALF_UP

NUMBER = re.compile(r'(?<![\w.])[-+]?\d{1,3}(?:[, ]\d{3})+(?:\.\d+)?(?!\d)|(?<![\w.])[-+]?\d+(?:\.\d+)?')
UNIT = re.compile(r'\s*(%|percent(?:age)?\b|per\s+cent\b|(?:mg|g|kg)\s*/\s*(?:day|d)\b|participants?\b|individuals?\b|people\b|persons?\b|veterans?\b)', re.I)
QUALIFIER = re.compile(r'(>=|<=|>|<|≥|≤|more than|greater than|over|at least|less than|under|at most|no more than|nearly|almost|approximately|about|around)\s*$', re.I)
OPS = {'>': 'gt', 'over': 'gt', 'more than': 'gt', 'greater than': 'gt',
       '>=': 'ge', '≥': 'ge', 'at least': 'ge', '<': 'lt', 'less than': 'lt',
       'under': 'lt', '<=': 'le', '≤': 'le', 'at most': 'le', 'no more than': 'le',
       'nearly': 'nearly', 'almost': 'nearly', 'approximately': 'approx',
       'about': 'approx', 'around': 'approx'}

def normalize(text):
    text = unicodedata.normalize('NFKC', str(text)).replace('−', '-')
    return re.sub(r'(?<=\d)·(?=\d)', '.', text)

def unit_name(unit):
    unit = re.sub(r'\s+', '', unit.lower())
    if unit in ('%', 'percent', 'percentage'): return '%'
    if unit in ('participants','participant','individuals','individual','people','persons','person','veterans','veteran'): return 'persons'
    return unit.replace('/day', '/d')

def percent_table(text, start, end):
    # Only a point estimate immediately followed by an SE in a percent(SE)
    # table. Never infer a percent from an arbitrary nearby bare number.
    heads = list(re.finditer(r'\bTABLE\s+\d+', text[:start], re.I))
    if not heads: return False
    prefix = text[heads[-1].end():start]
    return (len(prefix) <= 3000 and re.search(r'%\s*\(SE\)', prefix, re.I) is not None
            and re.match(r'\s*\(\d+(?:\.\d+)?\)', text[end:]) is not None)

def tokens(text, *, source=False):
    text = normalize(text)
    for m in NUMBER.finditer(text):
        raw = m[0]; value = Decimal(raw.replace(',', '').replace(' ', ''))
        suffix = UNIT.match(text[m.end():]); unit = unit_name(suffix[1]) if suffix else None
        if unit == 'persons' and re.match(r'[-\s]+(?:years?|months?|days?)\b', text[m.end()+suffix.end():], re.I):
            unit = 'person_time'
        unit_origin = 'explicit' if suffix else None
        if source and unit is None and percent_table(text, m.start(), m.end()):
            unit, unit_origin = '%', 'percent_SE_table'
        qualifier = QUALIFIER.search(text[max(0,m.start()-25):m.start()])
        op = OPS[qualifier[1].lower()] if qualifier else 'eq'
        if qualifier and re.search(r'\b(?:not|never)\s*$', text[max(0,m.start()-25):m.start()][:qualifier.start()], re.I):
            op = 'negated_bound'
        yield {'token': raw + ('%' if unit=='%' and unit_origin=='explicit' else ''),
               'value':value, 'unit':unit, 'op':op, 'span':[m.start(),m.end()], 'unit_origin':unit_origin}

def compatible(claim, candidate):
    a,b=claim['value'],candidate['value'];op=claim['op']
    # Unitless exact numeric presence is retained, but explicit units must match.
    if claim['unit'] != candidate['unit']: return None
    if candidate['op'] != 'eq':
        # Avoid treating a source bound as an exact observation.
        return 'same_bound' if op==candidate['op'] and a==b else None
    if op=='eq': return 'exact_normalized' if a==b else None
    if op in ('gt','ge','lt','le'):
        if claim['unit'] is None: return None
        return 'explicit_inequality' if {'gt':b>a,'ge':b>=a,'lt':b<a,'le':b<=a}[op] else None
    if op in ('nearly','approx'):
        # Restrict rounding to positive, explicitly identified person counts.
        # No tolerance for risks, percentages, doses, decimals, or bare numbers.
        clean=claim['token'].replace(',','').replace(' ','')
        if claim['unit']!='persons' or not clean.isdigit() or a<=0 or b<0 or b!=b.to_integral_value(): return None
        trailing=len(clean)-len(clean.rstrip('0'))
        precision=min(trailing,max(0,len(clean)-2))
        quantum=Decimal(10)**precision
        rounded=(b/quantum).quantize(Decimal(1),rounding=ROUND_HALF_UP)*quantum
        if rounded==a and (op!='nearly' or b<a): return 'explicit_count_rounding'
    return None

def numeric_checks(sentence, corpus):
    sentence=re.sub(r'\[[\d\s,;–—-]+\]|\^\{[^}]+\}', '', sentence)
    candidates=list(tokens(corpus,source=True));checks=[]
    for claim in tokens(sentence):
        raw=claim['token'];a=claim['value']
        # Preserve the old filter for small bare integers and year-like values.
        if raw.isdigit() and claim['op']=='eq' and claim['unit'] is None and (a<=12 or 1900<=a<=2100): continue
        match=None
        for candidate in candidates:
            method=compatible(claim,candidate)
            if method:
                match={'source_token':candidate['token'],'source_value':str(candidate['value']),
                       'source_span':candidate['span'],'unit_origin':candidate['unit_origin'],'method':method};break
        checks.append({'claim_token':raw,'claim_value':str(a),'unit':claim['unit'],'operator':claim['op'],'match':match})
    return checks

def missing_numbers(sentence, corpus):
    return list(dict.fromkeys(x['claim_token'] for x in numeric_checks(sentence,corpus) if x['match'] is None))
